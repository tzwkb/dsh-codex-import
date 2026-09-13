/**
 * Bounded-memory discovery for Codex rollout files.
 *
 * Inventory is deliberately separate from conversion: a list operation only
 * needs paths, timestamps, and a small metadata prefix, while conversion can
 * load one selected conversation at a time.
 *
 * @module dsh-codex-import/codex-discovery
 */
import { readdirSync, openSync, readSync, closeSync, lstatSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { decodeFrameBuffers } from './zstd.js'

const ROLLOUT_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl(?:\.zst)?$/
const READ_CHUNK_BYTES = 64 * 1024
const METADATA_SCAN_RECORDS = 128

/** Compare Codex timestamps while placing malformed values at the end. */
export function timestampOrder(value) {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/** Codex home, honoring CODEX_HOME. */
export function codexSessionsRoot() {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'sessions')
    : join(homedir(), '.codex', 'sessions')
}

/** Parse Codex's local wall-clock filename timestamp without date rollover. */
function filenameStamp(match) {
  const parts = match.slice(1, 7).map(Number)
  const [year, month, day, hour, minute, second] = parts
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return NaN
  const date = new Date(year, month - 1, day, hour, minute, second)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return NaN
  return date.getTime()
}

/** Resolve the primary and optional archived Codex rollout roots. */
export function rolloutRoots(root = codexSessionsRoot(), includeArchived = false) {
  const supplied = Array.isArray(root) ? root : [root]
  const roots = []
  for (const candidate of supplied) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    roots.push(candidate)
    if (!includeArchived) continue
    const leaf = basename(candidate)
    if (leaf === 'sessions') roots.push(join(dirname(candidate), 'archived_sessions'))
    else if (leaf === 'archived_sessions') roots.push(join(dirname(candidate), 'sessions'))
  }
  return [...new Set(roots)]
}

/** Find rollout files by their filename timestamp, never by mtime. */
export function findRollouts(sinceHours, root = codexSessionsRoot(), options = {}) {
  if (!Number.isFinite(sinceHours) || sinceHours < 0) {
    throw new Error('sinceHours must be a non-negative finite number')
  }
  const includeArchived = options === true || options?.includeArchived === true
  const cutoff = Date.now() - sinceHours * 3600_000
  const found = []
  const walk = (dir, sourceRoot) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, sourceRoot)
      else if (entry.isFile()) {
        const match = ROLLOUT_RE.exec(entry.name)
        if (match === null) continue
        const stamp = filenameStamp(match)
        if (!Number.isFinite(stamp) || stamp < cutoff) continue
        found.push({ path: full, stamp, archived: basename(sourceRoot) === 'archived_sessions' })
      }
    }
  }
  for (const candidate of rolloutRoots(root, includeArchived)) {
    try {
      const rootStat = lstatSync(candidate)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue
    } catch {
      continue
    }
    walk(candidate, candidate)
  }
  return found.sort((a, b) => a.stamp - b.stamp || a.path.localeCompare(b.path))
}

/** Yield parsed records without materialising a complete rollout string. */
export function* readRecordStream(path) {
  const parseLine = function* (line) {
    const clean = (line.endsWith('\r') ? line.slice(0, -1) : line).replace(/^\uFEFF/, '')
    if (clean.length === 0) return
    try {
      yield JSON.parse(clean)
    } catch {
      // A live rollout may end with a torn JSON line; keep all complete lines.
    }
  }
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let finished = false
  const consumeChunk = function* (chunk) {
    pending += decoder.write(chunk)
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      yield* parseLine(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
  }
  const finish = function* () {
    if (finished) return
    finished = true
    pending += decoder.end()
    if (pending.length > 0) yield* parseLine(pending)
  }

  // Codex can compact cold rollouts into one or more independently compressed
  // JSONL frames. Keep one line buffer across frame boundaries: a compressor is
  // free to split a UTF-8 record between frames, and decoding each frame in
  // isolation would silently discard that record.
  if (path.endsWith('.zst')) {
    try {
      for (const frame of decodeFrameBuffers(readFileSync(path))) {
        // Keep the bytes intact until the shared StringDecoder sees them. A
        // valid UTF-8 code point may straddle two independently compressed
        // frames; decoding each frame to a string first would replace that
        // split character with U+FFFD and make its JSON line unparsable.
        yield* consumeChunk(frame)
      }
      yield* finish()
    } catch {
      // A partially-written compressed rollout is treated like a torn plain
      // JSONL file: keep it out of the inventory until Codex finishes it.
    }
    return
  }

  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  try {
    let bytes
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      yield* consumeChunk(chunk.subarray(0, bytes))
    }
    yield* finish()
  } catch {
    // A rollout can be rotated or removed while an inventory scan is running.
    // Complete records already yielded remain useful; the damaged tail is
    // treated like a torn JSONL line rather than aborting the whole scan.
    try { yield* finish() } catch { /* a torn UTF-8 tail is intentionally ignored */ }
  } finally {
    try { closeSync(fd) } catch { /* the source may have disappeared mid-read */ }
  }
}

/** Read one rollout file into parsed records, skipping unparsable lines. */
export function readRecords(path) {
  return [...readRecordStream(path)]
}

/** Return a non-empty string id, accepting Codex's UUID and legacy shapes. */
export function stringId(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** The current Codex field is `id`; older rollouts used `session_id`. */
export function metadataId(payload) {
  return stringId(payload?.id) ?? stringId(payload?.session_id)
}

/** Sub-agent rollouts should not become a second parent session. */
export function isSubagentMetadata(payload) {
  return String(payload?.thread_source ?? '').toLowerCase() === 'subagent'
    || (payload?.source !== null && typeof payload?.source === 'object' && Boolean(payload.source.subagent))
}

/** Read bounded metadata and lineage from one rollout. */
export function readRolloutMetadata(path) {
  const payloads = []
  let firstRecord
  try {
    let scanned = 0
    for (const record of readRecordStream(path)) {
      if (firstRecord === undefined) firstRecord = record
      if (record?.type === 'session_meta' && record.payload !== null && typeof record.payload === 'object') {
        payloads.push(record.payload)
      }
      scanned += 1
      if (scanned >= METADATA_SCAN_RECORDS) break
    }
  } catch {
    return { firstRecord: undefined, payloads: [] }
  }
  const ownId = metadataId(payloads[0])
  const last = payloads.at(-1)
  const rootId = stringId(last?.session_id) ?? metadataId(last) ?? ownId
  const sourceIds = new Set()
  for (const payload of payloads) {
    const id = stringId(payload?.id)
    const sessionId = stringId(payload?.session_id)
    if (id !== undefined) sourceIds.add(id)
    if (sessionId !== undefined) sourceIds.add(sessionId)
  }
  if (ownId !== undefined) sourceIds.add(ownId)
  if (rootId !== undefined) sourceIds.add(rootId)
  const meta = last ?? payloads[0] ?? {}
  const firstTs = typeof firstRecord?.timestamp === 'string'
    ? firstRecord.timestamp
    : typeof payloads[0]?.timestamp === 'string' ? payloads[0].timestamp : ''
  return {
    firstRecord,
    payloads,
    ownId,
    rootId,
    sourceIds: [...sourceIds],
    isSubagent: payloads.some((payload) => isSubagentMetadata(payload)),
    firstTs,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : typeof payloads[0]?.cwd === 'string' ? payloads[0].cwd : '',
    provider: typeof meta.model_provider === 'string' ? meta.model_provider : typeof payloads[0]?.model_provider === 'string' ? payloads[0].model_provider : '',
    model: typeof meta.model === 'string' ? meta.model : typeof payloads[0]?.model === 'string' ? payloads[0].model : '',
  }
}

/** Match a project path exactly or one of its descendants. */
export function projectMatches(cwd, project) {
  if (project === undefined || project === null || String(project).trim().length === 0) return true
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const normalize = (value) => {
    const normalized = String(value).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    if (normalized.length > 1) return normalized.replace(/\/+$/, '')
    return normalized
  }
  const actual = normalize(cwd)
  const wanted = normalize(project)
  if (wanted === '/') return actual.startsWith('/')
  return actual === wanted || actual.startsWith(`${wanted}/`)
}
