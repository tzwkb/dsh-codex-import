#!/usr/bin/env node
/**
 * CLI for the Codex → DSH import.
 *
 *   import-codex list    [--since-hours N]
 *   import-codex convert --out DIR [--since-hours N | --session ID]... [--dry-run]
 *   import-codex sync    [--into SESSIONS_ROOT] [same selection flags] [--force]
 *   import-codex verify  PATH...
 *
 * `convert` writes a directory of session logs and stops there, so the result
 * can be inspected before anything reaches a live store. `sync` is the same
 * pipeline aimed at a sessions root: convert to a scratch directory, verify,
 * then reconcile session by session against what is already installed. `verify`
 * also accepts a conversion output directory.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runImport, listConversations } from '../lib/convert.js'
import { verifyPaths } from '../lib/verify.js'
import { syncSessions, writeManifest, manifestPath, readState } from '../lib/sync.js'
import { openAttachmentStore, resolveDshHome } from '../lib/store.js'

function parse(argv) {
  const opts = {
    out: undefined, into: undefined, sinceHours: 24, sessionIds: [],
    maxToolOutput: 0, dryRun: false, force: false, images: true, paths: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--into') opts.into = argv[++i]
    else if (a === '--since-hours') opts.sinceHours = Number(argv[++i])
    else if (a === '--session') opts.sessionIds.push(argv[++i])
    else if (a === '--max-tool-output') opts.maxToolOutput = Number(argv[++i])
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--no-images') opts.images = false
    else opts.paths.push(a)
  }
  return opts
}

/** Open the attachment store, or explain why images will not come across. */
async function storeFor(opts) {
  if (opts.images === false) return undefined
  try {
    return await openAttachmentStore()
  } catch (error) {
    console.log(`WARNING: could not open the attachment store (${String(error?.message ?? error)})`)
    console.log('         images will be skipped rather than silently attached.')
    return undefined
  }
}

/** Totals shared by the convert and sync reports. */
function totalsOf(results) {
  return results.reduce((a, r) => ({
    records: a.records + r.records,
    reasoning: a.reasoning + r.stats.reasoning,
    tools: a.tools + r.stats.toolCalls,
    injected: a.injected + r.stats.injected,
    truncated: a.truncated + r.stats.truncated,
    images: a.images + r.stats.imagesSkipped + r.stats.imagesImported,
    imported: a.imported + r.stats.imagesImported,
    history: a.history + r.stats.historyMessages,
  }), { records: 0, reasoning: 0, tools: 0, injected: 0, truncated: 0, images: 0, imported: 0, history: 0 })
}

function printConversion(results, rollouts, imageRefusals, store) {
  const totals = totalsOf(results)
  console.log(`rollout files scanned: ${rollouts}`)
  console.log(`conversations:         ${results.length}\n`)
  console.log('conversation          seg  turns  records  reason  tools  synth   cwd')
  for (const r of results) {
    console.log(
      `${r.id.slice(8, 28).padEnd(20)} ${String(r.segments).padStart(3)} ${String(r.turns).padStart(6)} `
      + `${String(r.records).padStart(8)} ${String(r.stats.reasoning).padStart(7)} ${String(r.stats.toolCalls).padStart(6)} `
      + `${String(r.stats.synthesized).padStart(6)}   ${r.cwd}`,
    )
  }
  console.log(
    `\n${results.length} sessions, ${totals.records} records, ${totals.reasoning} reasoning summaries, `
    + `${totals.tools} tool calls, ${totals.injected} injected messages dropped, ${totals.truncated} outputs truncated`,
  )
  if (totals.history > 0) console.log(
    `${totals.history} message(s) recovered from compaction history (present nowhere else in the Codex log)`,
  )
  if (totals.imported > 0) console.log(`${totals.imported} image(s) attached via ${store.root}`)
  for (const refusal of imageRefusals ?? []) {
    console.log(`  refused image (${refusal.mediaType}): ${refusal.reason}`)
  }
  if (store === undefined && totals.images > 0) {
    // The attachment store re-encodes an image before hashing it, so a durable
    // reference cannot be fabricated. Without the store the images are counted
    // rather than quietly attached with a made-up id.
    console.log(
      `\nWARNING: ${totals.images} image(s) were NOT imported. Run this inside dsh-tui\n`
      + '(/import-codex) or with the store reachable, so each image can be admitted properly.',
    )
  }
  return totals
}

const [command, ...rest] = process.argv.slice(2)
const opts = parse(rest)

if (command === 'list') {
  const { rollouts, rows } = listConversations({ sinceHours: opts.sinceHours })
  if (rows.length === 0) {
    console.log(`no conversations started in the last ${opts.sinceHours} h (scanned ${rollouts} rollout files)`)
    process.exit(1)
  }
  console.log(`${rows.length} conversation(s) from ${rollouts} rollout file(s), newest first:\n`)
  console.log('started           last              seg  msgs  session id                              cwd')
  for (const row of [...rows].reverse()) {
    console.log(
      `${row.startedAt.slice(0, 16).replace('T', ' ')}  ${row.lastAt.slice(0, 16).replace('T', ' ')}  `
      + `${String(row.segments).padStart(3)} ${String(row.prompts).padStart(5)}  ${row.sessionId}  ${row.cwd}`,
    )
    if (row.prompt.length > 0) console.log(`                                                          “${row.prompt}”`)
  }
  console.log('\nImport one with:  import-codex sync --session <session id>')
  console.log(`Import the window: import-codex sync --since-hours ${opts.sinceHours}`)
  process.exit(0)
} else if (command === 'convert' || command === 'sync') {
  if (command === 'convert' && !opts.dryRun && opts.out === undefined) {
    console.error('convert: --out DIR is required (or pass --dry-run)')
    process.exit(2)
  }
  // `sync` converts into a scratch tree and only publishes after verification,
  // exactly as /import-codex does; nothing is written to a live root unverified.
  const scratch = command === 'sync' ? mkdtempSync(join(tmpdir(), 'codex-sync-')) : opts.out
  const target = opts.into ?? join(resolveDshHome(), 'sessions')
  try {
    const store = await storeFor(opts)
    const { rollouts, results, imageRefusals } = await runImport({
      root: scratch,
      sinceHours: opts.sinceHours,
      sessionIds: opts.sessionIds,
      maxToolOutput: opts.maxToolOutput,
      dryRun: opts.dryRun,
      saveImages: store?.saveImages,
    })
    if (results.length === 0) {
      console.log(`no conversations matched (scanned ${rollouts} rollout files)`)
      process.exit(1)
    }
    printConversion(results, rollouts, imageRefusals, store)
    if (opts.dryRun) {
      console.log('(dry run — nothing written)')
      process.exit(0)
    }
    const verified = command === 'sync' ? await verifyPaths([scratch], { quiet: true }) : undefined
    if (verified !== undefined && verified.failed > 0) {
      console.error(`\nABORTED: ${verified.failed} of ${results.length} sessions failed verification; nothing was installed.`)
      for (const f of verified.failures.slice(0, 3)) console.error(`  - ${f.log}: ${f.message}`)
      process.exit(1)
    }
    if (command === 'convert') process.exit(0)

    const buckets = syncSessions(scratch, target, results, opts.force)
    const manifest = writeManifest(target, buckets)
    console.log(`\nsessions root: ${target}`)
    console.log(`  ${buckets.installed.length} new, ${buckets.refreshed.length} refreshed, `
      + `${buckets.unchanged.length} already up to date, ${buckets.refused.length} left alone`)
    if (buckets.refreshed.length > 0) {
      console.log('  refreshed in place: session ids are unchanged, so /resume entries stay valid')
      for (const key of buckets.refreshed.slice(0, 10)) console.log(`    ~ ${key}`)
    }
    for (const r of buckets.refused.slice(0, 10)) console.log(`    ! ${r.key} — ${r.reason}`)
    console.log(`  rollback list: ${manifest} (xargs rm -rf < it)`)
    console.log(`  state: ${Object.keys(readState(target).sessions).length} session(s) recorded`)
    process.exit(0)
  } catch (error) {
    console.error(String(error?.stack ?? error))
    process.exit(1)
  } finally {
    if (command === 'sync') rmSync(scratch, { recursive: true, force: true })
  }
} else if (command === 'verify') {
  if (opts.paths.length === 0) {
    console.error('verify: give at least one session directory or root')
    process.exit(2)
  }
  try {
    const result = await verifyPaths(opts.paths)
    console.log(`\n${result.passed} passed, ${result.failed} failed, ${result.events} events validated`)
    process.exit(result.failed === 0 ? 0 : 1)
  } catch (error) {
    console.error(String(error.message))
    process.exit(2)
  }
} else {
  console.error('usage: import-codex <list|convert|sync|verify> [options]')
  process.exit(2)
}
