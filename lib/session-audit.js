/**
 * Audit an installed sessions root for histories that can no longer be sent.
 *
 * An import can be perfectly well-formed and still unusable: if the derived
 * history exceeds the model's context window, the harness cannot build a
 * request for it, and compaction cannot rescue it either — condensing a span
 * means replaying that span to the summarizer, so the one shape that cannot be
 * summarised is the one that most needs to be. Measuring installed sessions is
 * therefore the only way to find the ones a user will hit this on.
 *
 * The audit is strictly read-only: it opens logs, prices the surface they
 * derive, and reports. It never rewrites, and it refuses to follow symlinks, so
 * pointing it at a live sessions root cannot damage one.
 *
 * @module dsh-codex-import/session-audit
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { decodeFrames } from './zstd.js'
import { estimateSessionTokens } from './session-tokens.js'

/** Token count above which a session is reported as at risk of not compacting. */
export const CONTEXT_ADVISORY_TOKENS = 700_000

/** Skip absurdly large logs rather than reading them into memory. */
const MAX_AUDIT_BYTES = 512 * 1024 * 1024

/**
 * Walk a sessions root and return every session log beneath it.
 *
 * @param root - sessions root, or one project directory beneath it.
 * @returns absolute log paths, in directory order.
 */
export function findSessionLogs(root) {
  const found = []
  const walk = (path) => {
    let info
    try {
      info = lstatSync(path)
    } catch {
      return
    }
    // A symlink is never followed: an attacker-controlled link inside a
    // sessions root must not be able to point the audit at arbitrary files.
    if (info.isSymbolicLink()) return
    if (info.isFile()) {
      if (basename(path) === 'session.v3.jsonl.zstd') found.push(path)
      return
    }
    if (!info.isDirectory()) return
    let entries
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const entry of entries) walk(join(path, entry))
  }
  walk(root)
  return found
}

/**
 * Price one installed session log.
 *
 * @param path - absolute path to `session.v3.jsonl.zstd`.
 * @returns the session id, its created time, and the priced surface.
 */
export function auditSessionLog(path) {
  const size = (() => {
    try {
      return lstatSync(path).size
    } catch {
      return 0
    }
  })()
  if (size > MAX_AUDIT_BYTES) {
    return { id: basename(dirname(path)), path, bytes: size, skipped: `larger than ${MAX_AUDIT_BYTES} bytes` }
  }
  const frames = decodeFrames(readFileSync(path))
  if (frames.length < 2) {
    return { id: basename(dirname(path)), path, bytes: size, skipped: 'not a two-frame session log' }
  }
  // Frame 0 is the header line; the events follow in every later frame.
  const lines = frames.slice(1).join('').split('\n').filter((line) => line.length > 0)
  let header
  try {
    header = JSON.parse(frames[0].split('\n')[0])
  } catch {
    header = undefined
  }
  const events = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // A malformed line is the harness's problem to report, not the audit's;
      // skipping it keeps the price conservative rather than failing the walk.
    }
  }
  const priced = estimateSessionTokens(events)
  return {
    id: typeof header?.id === 'string' ? header.id : basename(dirname(path)),
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    path,
    bytes: size,
    events: events.length,
    surfaceNodes: priced.nodes,
    estimatedTokens: priced.tokens,
  }
}

/**
 * Audit every session below a root.
 *
 * @param root - sessions root to walk.
 * @returns per-session prices plus the ids above {@link CONTEXT_ADVISORY_TOKENS},
 *   ordered largest first.
 */
export function auditSessionsRoot(root) {
  const sessions = findSessionLogs(root).map(auditSessionLog)
  const oversized = sessions
    .filter((session) => (session.estimatedTokens ?? 0) > CONTEXT_ADVISORY_TOKENS)
    .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
  return {
    root,
    sessions,
    oversized,
    totalTokens: sessions.reduce((sum, session) => sum + (session.estimatedTokens ?? 0), 0),
  }
}
