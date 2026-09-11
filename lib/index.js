/**
 * dsh-codex-import — import Codex conversations into DSH as resumable sessions.
 *
 * Registers `/import-codex`. The flow is deliberately two-phase: convert into a
 * scratch directory, verify it against the harness's own validators plus the
 * tool-call pairing check, and only then copy into the live sessions root.
 * Writing first and verifying later is how a broken import reaches a real
 * store; every check here exists because a weaker one already passed once.
 *
 * @module dsh-codex-import
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { runImport, listConversations } from './convert.js'
import { verifyPaths } from './verify.js'
import { syncSessions, writeManifest } from './sync.js'

export const name = 'codex-import'
// `attachments` is required for images: the store normalizes an image before
// hashing it, so a durable reference cannot be reconstructed outside it.
export const inject = ['commands', 'attachments']

/** Sessions root for the active DSH home (the persistence backend's default). */
function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(home, 'sessions')
}

const USAGE = [
  'Usage: /import-codex [options]',
  '',
  'With no selection option it LISTS what is available and writes nothing.',
  'Pick a scope from that list, then import it:',
  '',
  '  --session ID         import one Codex session id (repeatable)',
  '  --since-hours N      import conversations started within N hours',
  '  --list               list without importing',
  '  --max-tool-output N  keep at most N chars per tool output (default 0,',
  '                       which keeps everything; a positive N truncates)',
  '  --force              refresh even a session you have continued in DSH',
  '                       (DESTRUCTIVE: that session\'s own turns are deleted)',
  '  --dry-run            convert and verify only; write nothing',
  '',
  'Re-running is safe and incremental. A conversation already imported is',
  'compared against a fresh conversion: byte-identical content is left untouched,',
  'changed content is refreshed in place (same session id, so /resume and the',
  'workspace list stay valid), and a session you have continued inside DSH is',
  'never rewritten.',
  '',
  'Conversations are converted to a scratch directory and verified before any',
  'file reaches the sessions root.',
].join('\n')

/** Parse the command's raw input into import options. */
function parseInput(rawInput) {
  const opts = { sinceHours: 24, sinceHoursGiven: false, sessionIds: [], maxToolOutput: 0, dryRun: false, list: false, force: false }
  const argv = rawInput.trim().length === 0 ? [] : rawInput.trim().split(/\s+/)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') opts.list = true
    else if (a === '--since-hours') { opts.sinceHours = Number(argv[++i]); opts.sinceHoursGiven = true }
    else if (a === '--session') opts.sessionIds.push(argv[++i])
    else if (a === '--max-tool-output') opts.maxToolOutput = Number(argv[++i])
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--force') opts.force = true
    else if (a === '--help' || a === '-h') return { help: true }
    else throw new Error(`unknown option: ${a}`)
  }
  if (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0) throw new Error('--since-hours must be a positive number')
  if (!Number.isFinite(opts.maxToolOutput) || opts.maxToolOutput < 0) throw new Error('--max-tool-output must be zero or a positive number')
  // Bare `/import-codex` lists instead of importing everything in range: the
  // scope should be chosen deliberately, and listing writes nothing.
  opts.list = opts.list || (opts.sessionIds.length === 0 && !opts.sinceHoursGiven && !opts.dryRun)
  return opts
}

/** Render the `--list` inventory. */
function listReport(sinceHours) {
  const { rollouts, rows } = listConversations({ sinceHours })
  if (rows.length === 0) return `No conversations started in the last ${sinceHours} h (scanned ${rollouts} rollout files).`
  const lines = [`${rows.length} conversation(s) in the last ${sinceHours} h, newest first:`, '']
  for (const row of [...rows].reverse()) {
    lines.push(`${row.startedAt.slice(0, 16).replace('T', ' ')} → ${row.lastAt.slice(11, 16)}  ${row.sessionId}`)
    lines.push(`    ${row.cwd}`)
    if (row.prompt.length > 0) lines.push(`    “${row.prompt}”`)
  }
  lines.push('', `Import one:  /import-codex --session <id>`, `Import all:  /import-codex --since-hours ${sinceHours}`)
  return lines.join('\n')
}

/**
 * Run one import: convert → verify → reconcile.
 * @returns a human-readable report.
 */
async function runCommand(opts) {
  if (opts.list === true) return listReport(opts.sinceHours)
  const scratch = mkdtempSync(join(tmpdir(), 'codex-import-'))
  try {
    const { rollouts, results, imagesAvailable, imageRefusals } = await runImport({
      root: scratch,
      sinceHours: opts.sinceHours,
      sessionIds: opts.sessionIds,
      maxToolOutput: opts.maxToolOutput,
      dryRun: false,
      saveImages: (inputs) => ctx.attachments.saveImages(inputs),
    })
    if (results.length === 0) {
      return `No Codex conversations matched (scanned ${rollouts} rollout files).`
    }

    const verified = await verifyPaths([scratch], { quiet: true })
    if (verified.failed > 0) {
      const detail = verified.failures
        .slice(0, 3)
        .map((f) => `  - ${basename(dirname(f.log))}: ${f.message}`)
        .join('\n')
      return `Import aborted: ${verified.failed} of ${results.length} converted sessions failed verification.\n${detail}\nNothing was written to the sessions root.`
    }

    const totals = results.reduce((a, r) => ({
      records: a.records + r.records,
      reasoning: a.reasoning + r.stats.reasoning,
      tools: a.tools + r.stats.toolCalls,
      injected: a.injected + r.stats.injected,
      truncated: a.truncated + r.stats.truncated,
      imagesImported: a.imagesImported + r.stats.imagesImported,
      imagesSkipped: a.imagesSkipped + r.stats.imagesSkipped,
    }), { records: 0, reasoning: 0, tools: 0, injected: 0, truncated: 0, imagesImported: 0, imagesSkipped: 0 })

    const lines = [
      `Converted ${results.length} conversation(s) from ${rollouts} rollout file(s) — all verified.`,
      `  ${totals.records} records, ${totals.tools} tool calls, ${totals.reasoning} reasoning summaries recovered`,
      `  ${totals.injected} Codex-injected context messages dropped, ${totals.truncated} tool outputs truncated`,
    ]
    if (imagesAvailable > 0 || totals.imagesImported > 0) {
      lines.push(`  ${totals.imagesImported} image(s) attached (${imagesAvailable} distinct admitted to the attachment store)`)
    }
    for (const refusal of imageRefusals) {
      lines.push(`  refused image (${refusal.mediaType}): ${refusal.reason}`)
    }
    if (totals.imagesSkipped > 0) {
      lines.push(`  WARNING: ${totals.imagesSkipped} image(s) could not be attached and were dropped`)
    }

    if (opts.dryRun) {
      lines.push('', 'Dry run — nothing written to the sessions root.')
      return lines.join('\n')
    }

    const liveRoot = sessionsRoot()
    mkdirSync(liveRoot, { recursive: true, mode: 0o700 })
    const { installed, refreshed, unchanged, refused } = syncSessions(scratch, liveRoot, results, opts.force === true)
    // Record every session this import is responsible for, not just the newly
    // written ones: a re-run that touches nothing must not clobber the rollback
    // list with an empty file.
    const manifest = writeManifest(liveRoot, { installed, refreshed, unchanged })

    const summary = []
    if (installed.length > 0) summary.push(`${installed.length} new`)
    if (refreshed.length > 0) summary.push(`${refreshed.length} refreshed`)
    if (unchanged.length > 0) summary.push(`${unchanged.length} already up to date`)
    if (refused.length > 0) summary.push(`${refused.length} left alone`)
    lines.push('', `Sessions root: ${liveRoot} — ${summary.join(', ')}.`)
    if (refreshed.length > 0) {
      lines.push('  Refreshed in place: same session ids, so /resume entries and workspace state stay valid.')
    }
    for (const r of refused.slice(0, 5)) {
      lines.push(`  Left alone: ${r.key} — ${r.reason}.`)
    }
    if (refused.length > 5) lines.push(`  …and ${refused.length - 5} more left alone.`)
    if (refused.length > 0) {
      lines.push('  A session you have continued in DSH is never rewritten, because that would delete your turns.')
    }
    if (unchanged.length > 0 && installed.length === 0 && refreshed.length === 0) {
      lines.push('  Everything selected was already up to date — nothing was written.')
    }
    lines.push(
      'Restart dsh-tui if refreshed conversations still show their old content (sessions are read at startup).',
      `Rollback: xargs rm -rf < ${manifest}`,
      '',
      'Note: Codex reasoning is encrypted server-side; only its plaintext summaries are recoverable.',
    )
    return lines.filter((l) => l !== '').join('\n')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Register `/import-codex` for every composed human-command adapter. */
export function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'import-codex',
      description: 'Import Codex conversations as resumable DSH sessions',
      handler: async (invocation) => {
        let opts
        try {
          opts = parseInput(invocation.rawInput ?? '')
        } catch (error) {
          return { kind: 'error', text: `${String(error.message)}\n\n${USAGE}` }
        }
        if (opts.help === true) return { kind: 'success', text: USAGE }
        try {
          return { kind: 'success', text: await runCommand(opts) }
        } catch (error) {
          return { kind: 'error', text: `Import failed: ${String(error?.message ?? error)}` }
        }
      },
    })
    // Opt-in headless self-check. Slash commands are a human-adapter surface, so
    // there is no non-interactive way to ask the harness whether registration
    // happened; this records it from inside the composition instead.
    const selftest = process.env.DSH_CODEX_IMPORT_SELFTEST
    if (selftest !== undefined && selftest !== '') {
      const commands = ctx.commands
      const listed = typeof commands.list === 'function' ? commands.list() : undefined
      writeFileSync(selftest, `${JSON.stringify({
        plugin: name,
        command: 'import-codex',
        registered: true,
        sessionsRoot: sessionsRoot(),
        visibleCommands: Array.isArray(listed) ? listed.map((c) => c?.name ?? String(c)) : undefined,
      }, null, 2)}\n`)
    }
  }, 'codex-import lifecycle')
}
