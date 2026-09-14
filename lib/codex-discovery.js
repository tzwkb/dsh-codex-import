/**
 * Bounded-memory discovery for Codex rollout files.
 *
 * Inventory is deliberately separate from conversion: a list operation only
 * needs paths, timestamps, and a small metadata prefix, while conversion can
 * load one selected conversation at a time.
 *
 * @module dsh-codex-import/codex-discovery
 */
import { readdirSync, openSync, readSync, closeSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { decodeFrameBuffers } from './zstd.js'

const ROLLOUT_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl(?:\.zst)?$/
const READ_CHUNK_BYTES = 64 * 1024
const METADATA_SCAN_RECORDS = 128
// A tail this size holds the newest record of every ordinary rollout. Larger
// single records (a huge tool output) widen the window up to the limit.
const ACTIVITY_TAIL_BYTES = 256 * 1024
const ACTIVITY_TAIL_LIMIT = 4 * 1024 * 1024

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

/** Every id a rollout filename carries: the conversation root and any page id. */
export function filenameIds(path) {
  const match = ROLLOUT_RE.exec(basename(path))
  if (match === null) return []
  const ids = new Set()
  for (const part of match[7].split('_')) {
    if (part.length > 0) ids.add(part)
  }
  return [...ids]
}

/**
 * Conversation a rollout filename belongs to.
 *
 * Codex pages a long rollout into `<root>_<page>.jsonl` files, so the id before
 * the underscore — not the page id — names the conversation. Every other
 * rollout is named after its own conversation.
 */
export function filenameRoot(path) {
  const match = ROLLOUT_RE.exec(basename(path))
  if (match === null) return undefined
  const [root] = match[7].split('_')
  return root.length > 0 ? root : undefined
}

/** Newest record timestamp inside a tail window, ignoring torn edge lines. */
function newestTimestamp(buffer, wholeFile) {
  const lines = buffer.toString('utf8').split('\n')
  // The window starts mid-record unless it reaches byte 0, and a live rollout
  // ends with a half-written line; only complete lines are trusted.
  for (let index = lines.length - 1; index >= (wholeFile ? 0 : 1); index -= 1) {
    const line = (lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index]).trim()
    if (line.length === 0 || line[0] !== '{') continue
    try {
      const stamp = Date.parse(JSON.parse(line).timestamp ?? '')
      if (Number.isFinite(stamp)) return stamp
    } catch {
      // A torn or unparsable tail record: fall back to the record before it.
    }
  }
  return Number.NaN
}

/**
 * Timestamp of the newest complete record in a rollout, read from a bounded tail.
 *
 * Codex appends to one rollout file for as long as a conversation stays open, so
 * the newest record — not the filename — says whether the conversation is still
 * in use. Compressed rollouts are cold files that Codex never appends to; their
 * tail cannot be decoded on its own, so the filename timestamp speaks for them.
 */
export function lastRecordTimestamp(path) {
  if (path.endsWith('.zst')) return Number.NaN
  let fd
  try {
    fd = openSync(path, 'r')
  } catch {
    return Number.NaN
  }
  try {
    const size = statSync(path).size
    let length = Math.min(size, ACTIVITY_TAIL_BYTES)
    while (length > 0) {
      const buffer = Buffer.allocUnsafe(length)
      const bytes = readSync(fd, buffer, 0, length, size - length)
      const stamp = newestTimestamp(buffer.subarray(0, bytes), length >= size)
      if (Number.isFinite(stamp)) return stamp
      if (length >= size || length >= ACTIVITY_TAIL_LIMIT) return Number.NaN
      length = Math.min(size, length * 4)
    }
    return Number.NaN
  } catch {
    // A rollout can be rotated while it is inspected; an unreadable file simply
    // falls back to its filename timestamp.
    return Number.NaN
  } finally {
    try { closeSync(fd) } catch { /* the source may have disappeared mid-read */ }
  }
}

/** True when Codex is still appending to this rollout. */
function hasRecentActivity(file, cutoff) {
  if (file.stamp >= cutoff) return true
  // mtime is only a cheap gate for the tail read: the paginated rollout
  // migration rewrites cold files, which gives a months-old rollout today's
  // mtime, while its records still carry the original timestamps.
  if (file.mtimeMs < cutoff) return false
  const last = lastRecordTimestamp(file.path)
  return Number.isFinite(last) && last >= cutoff
}

/**
 * Find the rollout files selected by `sinceHours` of activity.
 *
 * The filename timestamp says when a rollout was *created*, which is not the
 * same as when the conversation was last used: Codex keeps appending to the
 * file of an open conversation for days. A conversation is therefore selected
 * when it started inside the window or when its newest record is inside it.
 * Every page of a selected conversation is returned — a page file holds only
 * its own turns, so importing the live page alone would truncate the session.
 */
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
        // A rollout Codex did not name is not part of the conversation graph.
        if (!Number.isFinite(stamp)) continue
        let mtimeMs = Number.NaN
        try { mtimeMs = statSync(full).mtimeMs } catch { /* removed mid-scan */ }
        found.push({
          path: full,
          stamp,
          archived: basename(sourceRoot) === 'archived_sessions',
          mtimeMs,
        })
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
  const selected = new Set()
  for (const file of found) {
    if (!hasRecentActivity(file, cutoff)) continue
    const conversation = filenameRoot(file.path)
    if (conversation !== undefined) selected.add(conversation)
  }
  return found
    .filter((file) => {
      const conversation = filenameRoot(file.path)
      return conversation !== undefined && selected.has(conversation)
    })
    .map(({ path, stamp, archived }) => ({ path, stamp, archived }))
    .sort((a, b) => a.stamp - b.stamp || a.path.localeCompare(b.path))
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
