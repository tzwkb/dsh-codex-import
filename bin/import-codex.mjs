#!/usr/bin/env node
/**
 * CLI for the Codex → DSH import.
 *
 *   import-codex list    [--since-hours N]
 *   import-codex convert --out DIR [--since-hours N | --session ID]... [--dry-run]
 *   import-codex verify  PATH...
 *
 * `verify` also accepts a conversion output directory, so the check can run
 * before anything reaches a live sessions root.
 */
import { runImport, listConversations } from '../lib/convert.js'
import { verifyPaths } from '../lib/verify.js'

function parse(argv) {
  const opts = { out: undefined, sinceHours: 24, sessionIds: [], maxToolOutput: 4000, dryRun: false, paths: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--since-hours') opts.sinceHours = Number(argv[++i])
    else if (a === '--session') opts.sessionIds.push(argv[++i])
    else if (a === '--max-tool-output') opts.maxToolOutput = Number(argv[++i])
    else if (a === '--dry-run') opts.dryRun = true
    else opts.paths.push(a)
  }
  return opts
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
  console.log('\nImport one with:  import-codex convert --session <session id> --out DIR')
  console.log(`Import the window: import-codex convert --since-hours ${opts.sinceHours} --out DIR`)
  process.exit(0)
} else if (command === 'convert') {
  if (!opts.dryRun && opts.out === undefined) {
    console.error('convert: --out DIR is required (or pass --dry-run)')
    process.exit(2)
  }
  const { rollouts, results, imageRefusals } = await runImport({
    root: opts.out,
    sinceHours: opts.sinceHours,
    sessionIds: opts.sessionIds,
    maxToolOutput: opts.maxToolOutput,
    dryRun: opts.dryRun,
  })
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
  const totals = results.reduce((a, r) => ({
    records: a.records + r.records,
    reasoning: a.reasoning + r.stats.reasoning,
    tools: a.tools + r.stats.toolCalls,
    injected: a.injected + r.stats.injected,
    truncated: a.truncated + r.stats.truncated,
    images: a.images + r.stats.imagesSkipped + r.stats.imagesImported,
    history: a.history + r.stats.historyMessages,
  }), { records: 0, reasoning: 0, tools: 0, injected: 0, truncated: 0, images: 0, history: 0 })
  console.log(
    `\n${results.length} sessions, ${totals.records} records, ${totals.reasoning} reasoning summaries, `
    + `${totals.tools} tool calls, ${totals.injected} injected messages dropped, ${totals.truncated} outputs truncated`,
  )
  if (totals.history > 0) console.log(
    `${totals.history} message(s) recovered from compaction history (present nowhere else in the Codex log)`,
  )
  if (totals.images > 0) {
    // The attachment store only exists inside a running harness, and it
    // normalizes images before storing them, so the durable reference cannot be
    // reconstructed here. Use /import-codex in dsh-tui to bring images across.
    console.log(
      `\nWARNING: ${totals.images} image(s) were NOT imported. This CLI has no attachment\n`
      + 'store, and the store re-encodes images before hashing them, so references cannot\n'
      + 'be fabricated. Run /import-codex inside dsh-tui to import images.',
    )
  }
  for (const refusal of imageRefusals ?? []) {
    console.log(`  refused image (${refusal.mediaType}): ${refusal.reason}`)
  }
  if (opts.dryRun) console.log('(dry run — nothing written)')
  process.exit(results.length === 0 ? 1 : 0)
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
  console.error('usage: import-codex <convert|verify> [options]')
  process.exit(2)
}
