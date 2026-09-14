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
import { join, basename, dirname, relative, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { realpath, stat } from 'node:fs/promises'
import { runImport, listConversations, formatLocalMinute } from './convert.js'
import { verifyPaths } from './verify.js'
import { assertSafeRoot, syncSessions, writeManifest } from './sync.js'

/** Scratch root can be redirected for isolated test runs; production defaults to the OS temp area. */
export function scratchRoot() {
  const configured = process.env.DSH_CODEX_IMPORT_TMP_ROOT
  return typeof configured === 'string' && configured.length > 0 ? configured : tmpdir()
}

export const name = 'codex-import'
// `attachments` is required for images: the store normalizes an image before
// hashing it, so a durable reference cannot be reconstructed outside it.
export const inject = ['commands', 'attachments']

/**
 * Sessions root for the active DSH profile.
 *
 * dsh-tui supports an explicit `DSH_TUI_SESSION_ROOT`; using only DSH_HOME
 * here silently writes imports where the profile never looks for them.
 */
export function sessionsRoot() {
  if (typeof process.env.DSH_TUI_SESSION_ROOT === 'string' && process.env.DSH_TUI_SESSION_ROOT.length > 0) {
    return process.env.DSH_TUI_SESSION_ROOT
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * Attach published sessions to the host's workspace registry when that
 * optional service is present. The registry remains the owner of workspace
 * ids and ordering; this helper only resolves real project directories and
 * calls its public `create`/`attachSession` methods.
 */
export async function groupIntoWorkspaces(ctx, imported, scratchRoot, buckets) {
  const registry = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry
  if (registry === undefined || imported.length === 0) {
    return { available: false, grouped: 0, workspaces: 0 }
  }
  const published = new Set([
    ...(buckets?.installed ?? []), ...(buckets?.refreshed ?? []), ...(buckets?.unchanged ?? []),
  ])
  const byPath = new Map()
  for (const entry of imported) {
    if (entry?.cwd === undefined || entry.cwd === '' || entry.id === undefined) continue
    if (scratchRoot !== undefined) {
      const key = relative(resolve(scratchRoot), resolve(entry.dir))
      // The caller may have converted sessions that sync refused. Only
      // sessions actually published by this run belong in the workspace
      // attachment pass; an empty published set therefore groups nothing.
      if (published.size === 0 || !published.has(key)) continue
    }
    let canonical
    try {
      canonical = await realpath(entry.cwd)
      if (!(await stat(canonical)).isDirectory()) continue
    } catch {
      // A historical project may have been deleted; leave its session usable
      // but ungrouped rather than creating a workspace at a stale path.
      continue
    }
    const list = byPath.get(canonical)
    if (list === undefined) byPath.set(canonical, [entry.id])
    else list.push(entry.id)
  }
  let grouped = 0
  for (const [path, ids] of byPath) {
    let workspace
    try {
      workspace = typeof registry.resolveByPath === 'function'
        ? await registry.resolveByPath(path) : undefined
      if (workspace === undefined && typeof registry.create === 'function') workspace = await registry.create(path)
    } catch {
      continue
    }
    if (workspace === undefined || typeof workspace.attachSession !== 'function') continue
    // Most registries prepend newly attached sessions; reverse the import's
    // chronological order so the newest imported item remains on top.
    for (const id of [...ids].reverse()) {
      try {
        await workspace.attachSession(id)
        grouped += 1
      } catch {
        // A stale/continued session should not make the whole import fail.
      }
    }
  }
  return { available: true, grouped, workspaces: byPath.size }
}

const USAGE = [
  'Usage: /import-codex [options]',
  '',
  'With no selection option it LISTS what is available and writes nothing.',
  'Pick a scope from that list, then import it:',
  '',
  '  --session ID         import one Codex session id (repeatable)',
  '  --since-hours N      import conversations active within the last N hours',
  '  --limit N            keep the newest N conversations after filtering',
  '  --project DIR        restrict imports to this project path (or descendants)',
  '  --archived           include $CODEX_HOME/archived_sessions',
  '  --codex-root DIR     read rollouts from DIR instead of $CODEX_HOME/sessions',
  '  --list               list without importing',
  '  --no-images          skip attachment-store image admission',
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
function tokenizeInput(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput : ''
  const tokens = []
  let token = ''
  let started = false
  let quote
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
        started = true
      } else if (ch === '\\' && quote === '"'
        && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        token += input[++i]
        started = true
      } else {
        token += ch
        started = true
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
    } else if (ch === '\\' && i + 1 < input.length
      && (/\s/.test(input[i + 1]) || input[i + 1] === '"'
        || input[i + 1] === "'" || input[i + 1] === '\\')) {
      token += input[++i]
      started = true
    } else {
      token += ch
      started = true
    }
  }
  if (quote !== undefined) throw new Error('unterminated quote in command input')
  if (started) tokens.push(token)
  return tokens
}

function parseInput(rawInput) {
  const opts = {
    sinceHours: 24, sinceHoursGiven: false, sessionIds: [], maxToolOutput: 0,
    limit: undefined, project: undefined, codexRoot: undefined, includeArchived: false,
    dryRun: false, list: false, force: false, images: true, explicitAction: false,
  }
  const argv = tokenizeInput(rawInput)
  const required = (index, option) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--list') opts.list = true
    else if (a === '--since-hours') {
      opts.sinceHours = Number(required(i++, a)); opts.sinceHoursGiven = true; opts.explicitAction = true
    } else if (a === '--limit') {
      opts.limit = Number(required(i++, a)); opts.explicitAction = true
    } else if (a === '--project') {
      opts.project = required(i++, a); opts.explicitAction = true
    } else if (a === '--codex-root') {
      opts.codexRoot = required(i++, a); opts.explicitAction = true
    } else if (a === '--archived') {
      opts.includeArchived = true; opts.explicitAction = true
    } else if (a === '--session') {
      opts.sessionIds.push(required(i++, a)); opts.explicitAction = true
    } else if (a === '--max-tool-output') {
      opts.maxToolOutput = Number(required(i++, a)); opts.explicitAction = true
    } else if (a === '--dry-run') {
      opts.dryRun = true; opts.explicitAction = true
    } else if (a === '--force') {
      opts.force = true; opts.explicitAction = true
    } else if (a === '--no-images') {
      opts.images = false; opts.explicitAction = true
    }
    else if (a === '--help' || a === '-h') return { help: true }
    else throw new Error(`unknown option: ${a}`)
  }
  if (!Number.isFinite(opts.sinceHours) || opts.sinceHours < 0) throw new Error('--since-hours must be a non-negative number')
  if (!Number.isSafeInteger(opts.maxToolOutput) || opts.maxToolOutput < 0) throw new Error('--max-tool-output must be zero or a positive integer')
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) throw new Error('--limit must be a positive integer')
  // Bare `/import-codex` lists instead of importing everything in range: the
  // scope should be chosen deliberately, and listing writes nothing.
  opts.list = opts.list || !opts.explicitAction
  return opts
}

/** Render the `--list` inventory. */
function listReport({ sinceHours, codexRoot, includeArchived, project }) {
  const { rollouts, rows } = listConversations({ sinceHours, codexRoot, includeArchived, project })
  if (rows.length === 0) {
    return `No conversations active in the last ${sinceHours} h (scanned ${rollouts} rollout files).\n`
      + 'Widen the window, for example: /import-codex --since-hours 168'
  }
  const lines = [`${rows.length} conversation(s) active in the last ${sinceHours} h, newest first:`, '']
  for (const row of [...rows].reverse()) {
    lines.push(`${formatLocalMinute(row.startedAt)} → ${formatLocalMinute(row.lastAt).slice(11)}  ${row.sessionId}`)
    lines.push(`    ${row.cwd}`)
    if (row.prompt.length > 0) lines.push(`    “${row.prompt}”`)
  }
  // A bare invocation only lists. Saying so here is what stops a reader from
  // waiting for conversations that were never written.
  lines.push(
    '',
    'Nothing was imported yet — this command only lists until you pick a scope:',
    'Import one:       /import-codex --session <id>',
    `Import all ${rows.length}:    /import-codex --since-hours ${sinceHours}`,
  )
  return lines.join('\n')
}

/**
 * Run one import: convert → verify → reconcile.
 * @returns a human-readable report.
 */
async function runCommand(opts, ctx, signal) {
  if (opts.list === true) return listReport(opts)
  const scratchBase = scratchRoot()
  assertSafeRoot(scratchBase, 'temporary import root')
  mkdirSync(scratchBase, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(join(scratchBase, 'codex-import-'))
  try {
    const { rollouts, results, imagesAvailable, imageRefusals } = await runImport({
      root: scratch,
      sinceHours: opts.sinceHours,
      sessionIds: opts.sessionIds,
      maxToolOutput: opts.maxToolOutput,
      limit: opts.limit,
      project: opts.project,
      includeArchived: opts.includeArchived,
      signal,
      dryRun: false,
      // A dry run still writes verified logs to scratch for validation, but it
      // must not create attachment objects as a side effect.
      codexRoot: opts.codexRoot,
      saveImages: opts.dryRun || opts.images === false ? undefined : (inputs) => ctx.attachments.saveImages(inputs),
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
      throw new Error(
        `Import aborted: ${verified.failed} of ${results.length} converted sessions failed verification.\n`
        + `${detail}\nNothing was written to the sessions root.`,
      )
    }

    const totals = results.reduce((a, r) => ({
      records: a.records + r.records,
      reasoning: a.reasoning + r.stats.reasoning,
      tools: a.tools + r.stats.toolCalls,
      errors: a.errors + (r.stats.toolErrors ?? 0),
      repaired: a.repaired + (r.stats.repairedTools ?? 0),
      injected: a.injected + r.stats.injected,
      truncated: a.truncated + r.stats.truncated,
      imagesImported: a.imagesImported + r.stats.imagesImported,
      imagesSkipped: a.imagesSkipped + r.stats.imagesSkipped,
    }), { records: 0, reasoning: 0, tools: 0, errors: 0, repaired: 0, injected: 0, truncated: 0, imagesImported: 0, imagesSkipped: 0 })

    const lines = [
      `Converted ${results.length} conversation(s) from ${rollouts} rollout file(s) — all verified.`,
      `  ${totals.records} records, ${totals.tools} tool calls (${totals.errors} failed), `
        + `${totals.repaired} orphaned tool results repaired, `
        + `${totals.reasoning} reasoning summaries recovered`,
      `  ${totals.injected} Codex-injected context messages dropped, ${totals.truncated} tool outputs truncated`,
    ]
    if (imagesAvailable > 0 || totals.imagesImported > 0) {
      lines.push(`  ${totals.imagesImported} image(s) attached (${imagesAvailable} distinct admitted to the attachment store)`)
    }
    for (const refusal of imageRefusals) {
      lines.push(`  refused image (${refusal.mediaType}): ${refusal.reason}`)
    }
    if (totals.imagesSkipped > 0) {
      lines.push(
        `  WARNING: ${totals.imagesSkipped} image(s) could not be attached; `
        + 'the transcript keeps an explicit omission placeholder',
      )
    }

    if (opts.dryRun) {
      lines.push('', 'Dry run — nothing written to the sessions root.')
      return lines.join('\n')
    }

    const liveRoot = sessionsRoot()
    assertSafeRoot(liveRoot)
    mkdirSync(liveRoot, { recursive: true, mode: 0o700 })
    const buckets = syncSessions(scratch, liveRoot, results, opts.force === true)
    const { installed, refreshed, unchanged, refused } = buckets
    // The manifest carries refresh backups as well as newly installed paths;
    // passing only the display buckets would make a refresh irreversible.
    const manifest = writeManifest(liveRoot, buckets)
    const grouped = await groupIntoWorkspaces(ctx, results, scratch, buckets)

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
    if (grouped.available) {
      lines.push(`  Grouped ${grouped.grouped} session(s) into ${grouped.workspaces} workspace(s).`)
    }
    if (unchanged.length > 0 && installed.length === 0 && refreshed.length === 0) {
      lines.push('  Everything selected was already up to date — nothing was written.')
    }
    lines.push('Restart dsh-tui if refreshed conversations still show their old content (sessions are read at startup).')
    if (manifest !== undefined) {
      lines.push(`Rollback safely: node bin/import-codex.mjs rollback --manifest ${manifest}`)
    }
    lines.push('', 'Note: Codex reasoning is encrypted server-side; only its plaintext summaries are recoverable.')
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
          return { kind: 'success', text: await runCommand(opts, ctx, invocation.signal) }
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
