#!/usr/bin/env node
/**
 * CLI for the Codex → DSH import.
 *
 *   import-codex list    [--since-hours N]
 *   import-codex convert --out DIR [--since-hours N | --session ID]... [--dry-run]
 *   import-codex sync    [--into SESSIONS_ROOT] [same selection flags] [--force]
 *   import-codex rollback [--manifest PATH]
 *   import-codex verify  PATH...
 *
 * `convert` writes a directory of session logs and stops there, so the result
 * can be inspected before anything reaches a live store. `sync` is the same
 * pipeline aimed at a sessions root: convert to a scratch directory, verify,
 * then reconcile session by session against what is already installed. `verify`
 * also accepts a conversion output directory.
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runImport, listConversations, formatLocalMinute, DEFAULT_MAX_TEXT_CHARS } from '../lib/convert.js'
import { verifyPaths } from '../lib/verify.js'
import { auditSessionsRoot, CONTEXT_ADVISORY_TOKENS } from '../lib/session-audit.js'
import { assertSafeRoot, syncSessions, writeManifest, manifestPath, readState, rollbackManifest } from '../lib/sync.js'
import { openAttachmentStore, resolveDshHome } from '../lib/store.js'

/** Keep disposable conversion trees under an explicit root when a caller needs isolation. */
function scratchRoot() {
  const configured = process.env.DSH_CODEX_IMPORT_TMP_ROOT
  return typeof configured === 'string' && configured.length > 0 ? configured : tmpdir()
}

const COMMANDS = new Set(['list', 'convert', 'sync', 'rollback', 'verify', 'audit'])
const USAGE = `Usage: import-codex <command> [options]

Commands:
  list       list conversations available for import
  convert    write converted session logs to --out DIR
  sync       verify and reconcile converted logs into a sessions root
  rollback   undo the most recent sync described by a manifest
  verify     validate one or more session directories
  audit      measure installed sessions and flag histories too large to compact

Selection and paths:
  --session ID          import one Codex session (repeatable)
  --since-hours N       select conversations active in the last N hours (default 24)
  --limit N              keep the newest N conversations after filtering
  --project DIR          restrict imports to this project path (or descendants)
  --archived             include $CODEX_HOME/archived_sessions
  --codex-root DIR       read Codex rollouts from DIR instead of $CODEX_HOME/sessions
  --out DIR              conversion output directory (convert)
  --into DIR             live sessions root (sync/rollback)
  --dsh-home DIR         DSH home used for sessions and attachments
  --manifest FILE        rollback manifest (default: metadata beside --into)

  audit also takes one positional path: the sessions root to measure.

Conversion options:
  --max-tool-output N   truncate tool output to N characters (default 0 = keep all)
  --max-text-chars N    keep at most N chars of any one text (default 262144; 0 = keep all)
  --full-history        replay every Codex turn instead of its current compaction window
  --no-images           skip attachment-store image admission
  --dry-run             convert and verify, without changing a live root
  --force               refresh a session that is not importer-owned (destructive)

By default a conversation is imported as Codex last held it: the newest
compaction checkpoint plus every turn after it. A rollout replays every turn
ever taken, so a long conversation imports many times larger than the context a
model can still accept — and a history that large cannot be compacted later,
because compaction has to replay the span that does not fit.

Examples:
  import-codex list --since-hours 168
  import-codex sync --since-hours 24
  import-codex rollback --manifest /path/to/codex-import-manifest.json
`

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = 2
  }
}

/** Render a token count compactly for a terminal table. */
const formatTokens = (tokens) => (tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens))

function requiredValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${option} requires a value`)
  }
  return value
}

function parse(argv) {
  const opts = {
    out: undefined, into: undefined, sinceHours: 24, sessionIds: [],
    maxToolOutput: 0, maxTextChars: DEFAULT_MAX_TEXT_CHARS, fullHistory: false,
    limit: undefined, project: undefined, includeArchived: false,
    dryRun: false, force: false, images: true, paths: [],
    codexRoot: undefined, dshHome: undefined, manifest: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a === '--out') { opts.out = requiredValue(argv, i++, a); continue }
    if (a === '--into') { opts.into = requiredValue(argv, i++, a); continue }
    if (a === '--codex-root') { opts.codexRoot = requiredValue(argv, i++, a); continue }
    if (a === '--dsh-home') { opts.dshHome = requiredValue(argv, i++, a); continue }
    if (a === '--manifest') { opts.manifest = requiredValue(argv, i++, a); continue }
    if (a === '--since-hours') { opts.sinceHours = Number(requiredValue(argv, i++, a)); continue }
    if (a === '--limit') { opts.limit = Number(requiredValue(argv, i++, a)); continue }
    if (a === '--project') { opts.project = requiredValue(argv, i++, a); continue }
    if (a === '--archived') { opts.includeArchived = true; continue }
    if (a === '--session') { opts.sessionIds.push(requiredValue(argv, i++, a)); continue }
    if (a === '--max-tool-output') { opts.maxToolOutput = Number(requiredValue(argv, i++, a)); continue }
    if (a === '--max-text-chars') { opts.maxTextChars = Number(requiredValue(argv, i++, a)); continue }
    if (a === '--full-history') { opts.fullHistory = true; continue }
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--no-images') opts.images = false
    else if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`)
    else opts.paths.push(a)
  }
  if (!Number.isFinite(opts.sinceHours) || opts.sinceHours < 0) {
    throw new UsageError('--since-hours must be a non-negative number')
  }
  if (!Number.isSafeInteger(opts.maxToolOutput) || opts.maxToolOutput < 0) {
    throw new UsageError('--max-tool-output must be zero or a positive integer')
  }
  if (!Number.isSafeInteger(opts.maxTextChars) || opts.maxTextChars < 0) {
    throw new UsageError('--max-text-chars must be zero or a positive integer')
  }
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new UsageError('--limit must be a positive integer')
  }
  return opts
}

function targetSessionsRoot(opts) {
  return opts.into
    ?? (typeof process.env.DSH_TUI_SESSION_ROOT === 'string' && process.env.DSH_TUI_SESSION_ROOT.length > 0
      ? process.env.DSH_TUI_SESSION_ROOT
      : join(opts.dshHome ?? resolveDshHome(), 'sessions'))
}

/** Open the attachment store, or explain why images will not come across. */
async function storeFor(opts) {
  if (opts.images === false || opts.dryRun === true) return undefined
  try {
    return await openAttachmentStore(opts.dshHome)
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
    errors: a.errors + (r.stats.toolErrors ?? 0),
    repaired: a.repaired + (r.stats.repairedTools ?? 0),
    injected: a.injected + r.stats.injected,
    truncated: a.truncated + r.stats.truncated,
    images: a.images + r.stats.imagesSkipped + r.stats.imagesImported,
    imported: a.imported + r.stats.imagesImported,
    history: a.history + r.stats.historyMessages,
    clamped: a.clamped + (r.stats.textClamped ?? 0),
    windowed: a.windowed + (r.stats.historyWindow === true ? 1 : 0),
  }), {
    records: 0, reasoning: 0, tools: 0, errors: 0, repaired: 0, injected: 0,
    truncated: 0, images: 0, imported: 0, history: 0, clamped: 0, windowed: 0,
  })
}

function printConversion(results, rollouts, imageRefusals, store) {
  const totals = totalsOf(results)
  console.log(`rollout files scanned: ${rollouts}`)
  console.log(`conversations:         ${results.length}\n`)
  console.log('conversation          seg  turns  records  reason  tools  synth  repair   context   cwd')
  for (const r of results) {
    const context = r.estimatedTokens === undefined ? '-' : formatTokens(r.estimatedTokens)
    console.log(
      `${r.id.slice(8, 28).padEnd(20)} ${String(r.segments).padStart(3)} ${String(r.turns).padStart(6)} `
      + `${String(r.records).padStart(8)} ${String(r.stats.reasoning).padStart(7)} ${String(r.stats.toolCalls).padStart(6)} `
      + `${String(r.stats.synthesized).padStart(6)} ${String(r.stats.repairedTools ?? 0).padStart(7)} `
      + `${context.padStart(9)}   ${r.cwd}`,
    )
  }
  console.log(
    `\n${results.length} sessions, ${totals.records} records, ${totals.reasoning} reasoning summaries, `
    + `${totals.tools} tool calls (${totals.errors} failed), ${totals.repaired} orphaned tool results repaired, `
    + `${totals.injected} injected messages dropped, ${totals.truncated} outputs truncated`,
  )
  if (totals.history > 0) console.log(
    `${totals.history} message(s) recovered from compaction history (present nowhere else in the Codex log)`,
  )
  if (totals.windowed > 0) console.log(
    `${totals.windowed} conversation(s) imported as Codex's current compaction window; `
    + '--full-history replays every turn instead',
  )
  if (totals.clamped > 0) console.log(
    `${totals.clamped} text block(s) trimmed to the per-text budget, each with an explicit marker`,
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

/** Execute the CLI without terminating inside a cleanup-sensitive try/finally. */
async function main() {
  let opts
  try {
    if (command === '--help' || command === '-h') {
      console.log(USAGE)
      return 0
    }
    if (!COMMANDS.has(command)) {
      throw new UsageError(command === undefined
        ? 'a command is required'
        : `unknown command: ${command}`)
    }
    opts = parse(rest)
    if (opts.help === true) {
      console.log(USAGE)
      return 0
    }
    if (command === 'verify' && opts.paths.length === 0) {
      throw new UsageError('verify requires at least one session directory or root')
    }
    if (command !== 'verify' && command !== 'audit' && opts.paths.length > 0) {
      throw new UsageError(`unexpected positional argument: ${opts.paths[0]}`)
    }
    if (command === 'convert' && !opts.dryRun && opts.out === undefined) {
      throw new UsageError('convert: --out DIR is required (or pass --dry-run)')
    }
  } catch (error) {
    console.error(`${String(error?.message ?? error)}\n\n${USAGE}`)
    return error?.exitCode ?? 2
  }

  if (command === 'audit') {
    const target = opts.paths[0] ?? targetSessionsRoot(opts)
    const report = auditSessionsRoot(target)
    console.log(`sessions root: ${report.root}`)
    console.log(`sessions:      ${report.sessions.length} (${formatTokens(report.totalTokens)} tokens of model context in total)\n`)
    if (report.oversized.length === 0) {
      console.log(`no session exceeds the ~${formatTokens(CONTEXT_ADVISORY_TOKENS)} token advisory; all are compactable.`)
      return 0
    }
    console.log(`session id                              context   records   cwd`)
    for (const session of report.oversized) {
      console.log(
        `${String(session.id).padEnd(38)} ${formatTokens(session.estimatedTokens).padStart(7)} `
        + `${String(session.events).padStart(8)}   ${session.cwd ?? '-'}`,
      )
    }
    console.log(
      `\n${report.oversized.length} session(s) hold more history than a summary can replay.`,
      '\nCompaction condenses a span by sending that span to the summarizer, so a history at or beyond',
      '\nthe model window can neither be sent nor condensed — the session looks fine and then refuses',
      '\nevery new turn.',
      '\n\nRebuild one from its Codex conversation, importing Codex\'s current window instead of the',
      '\nwhole rollout replay:',
      '\n  import-codex sync --session <codex session id> --force',
      '\n--force is required because the installed session is no longer exactly what the importer wrote.',
      '\nIt replaces only that session log; the Codex rollout is never modified.',
    )
    return 0
  }

  if (command === 'list') {
    const { rollouts, rows } = listConversations({
      sinceHours: opts.sinceHours, codexRoot: opts.codexRoot,
      includeArchived: opts.includeArchived, project: opts.project,
    })
    if (rows.length === 0) {
      console.log(`no conversations active in the last ${opts.sinceHours} h (scanned ${rollouts} rollout files)`)
      return 1
    }
    console.log(`${rows.length} conversation(s) from ${rollouts} rollout file(s), newest first:\n`)
    console.log('started (local)   last (local)      seg  msgs  session id                              cwd')
    for (const row of [...rows].reverse()) {
      console.log(
        `${formatLocalMinute(row.startedAt)}  ${formatLocalMinute(row.lastAt)}  `
        + `${String(row.segments).padStart(3)} ${String(row.prompts).padStart(5)}  ${row.sessionId}  ${row.cwd}`,
      )
      if (row.prompt.length > 0) console.log(`                                                          “${row.prompt}”`)
    }
    console.log('\nNothing was imported yet — this command only lists until you pick a scope:')
    console.log('Import one:    import-codex sync --session <session id>')
    console.log(`Import all ${rows.length}: import-codex sync --since-hours ${opts.sinceHours}`)
    return 0
  }

  if (command === 'rollback') {
    const target = targetSessionsRoot(opts)
    const manifest = opts.manifest ?? manifestPath(target)
    try {
      const result = rollbackManifest(manifest)
      console.log(`rollback: removed ${result.removed}, restored ${result.restored}, skipped ${result.skipped}`)
      return result.skipped > 0 ? 1 : 0
    } catch (error) {
      console.error(`rollback failed: ${String(error?.message ?? error)}`)
      return 1
    }
  }

  if (command === 'convert' || command === 'sync') {
    // `sync` converts into a scratch tree and only publishes after verification,
    // exactly as /import-codex does; nothing is written to a live root unverified.
    const temporary = command === 'sync' || opts.dryRun === true
    const scratchBase = scratchRoot()
    assertSafeRoot(scratchBase, 'temporary import root')
    mkdirSync(scratchBase, { recursive: true, mode: 0o700 })
    const scratch = temporary
      ? mkdtempSync(join(scratchBase, command === 'sync' ? 'codex-sync-' : 'codex-dry-run-'))
      : opts.out
    const target = targetSessionsRoot(opts)
    try {
      const store = await storeFor(opts)
      const { rollouts, results, imageRefusals } = await runImport({
        root: scratch,
        sinceHours: opts.sinceHours,
        sessionIds: opts.sessionIds,
        maxToolOutput: opts.maxToolOutput,
        maxTextChars: opts.maxTextChars,
        fullHistory: opts.fullHistory,
        limit: opts.limit,
        project: opts.project,
        includeArchived: opts.includeArchived,
        // The scratch tree is disposable. Materialise it even for --dry-run so
        // the same DSH validators exercise the exact bytes a real sync would use.
        dryRun: false,
        codexRoot: opts.codexRoot,
        saveImages: store?.saveImages,
      })
      if (results.length === 0) {
        console.log(`no conversations matched (scanned ${rollouts} rollout files)`)
        return 1
      }
      const verified = command === 'sync' || opts.dryRun
        ? await verifyPaths([scratch], { quiet: true })
        : undefined
      if (verified !== undefined && verified.failed > 0) {
        console.error(`\nABORTED: ${verified.failed} of ${results.length} sessions failed verification; nothing was installed.`)
        for (const f of verified.failures.slice(0, 3)) console.error(`  - ${f.log}: ${f.message}`)
        return 1
      }
      printConversion(results, rollouts, imageRefusals, store)
      if (opts.dryRun) {
        console.log(`verified: ${verified.passed} session(s), ${verified.events} events (all verified)`)
        console.log('(dry run — nothing written)')
        return 0
      }
      if (command === 'convert') return 0

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
      if (manifest !== undefined) console.log(`  rollback safely: import-codex rollback --manifest ${manifest}`)
      console.log(`  state: ${Object.keys(readState(target).sessions).length} session(s) recorded`)
      return 0
    } catch (error) {
      console.error(String(error?.stack ?? error))
      return 1
    } finally {
      if (temporary) rmSync(scratch, { recursive: true, force: true })
    }
  }

  if (command === 'verify') {
    try {
      const result = await verifyPaths(opts.paths)
      console.log(`\n${result.passed} passed, ${result.failed} failed, ${result.events} events validated`)
      return result.failed === 0 ? 0 : 1
    } catch (error) {
      console.error(String(error.message))
      return 2
    }
  }
  return 2
}

process.exitCode = await main()
