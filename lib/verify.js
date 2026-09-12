/**
 * Verification for generated DSH session logs.
 *
 * Grading is deliberately harsher than "the file parses", because two weaker
 * checks both passed while the imported sessions were still unusable:
 *
 *  1. `validateStoredEvents` — the listing/read path.
 *  2. `Session.create` — the restore path (`assertAssistantSettlementShape`).
 *  3. Tool-call pairing — the *continuation* path. The provider reads
 *     `tool_calls` from assistant `tool-call` content blocks, so a log whose
 *     tool results have no matching block resumes and lists fine, then fails
 *     the next turn with "Messages with role 'tool' must be a response to a
 *     preceding message with 'tool_calls'".
 *
 * Check 3 is enforced here because no harness validator covers it.
 *
 * @module dsh-codex-import/verify
 */
import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Locate the installed DSH package root.
 *
 * The explicit environment hooks are intentionally small and test-friendly:
 * an isolated checkout can point verification at its own downloaded runtime
 * without changing PATH or accidentally loading the user's global DSH.
 */
export function resolveDshRoot() {
  const configuredRoot = process.env.DSH_CODEX_IMPORT_DSH_ROOT
  if (typeof configuredRoot === 'string' && configuredRoot.length > 0) {
    return realpathSync(configuredRoot)
  }
  const configuredBin = process.env.DSH_CODEX_IMPORT_DSH_BIN
  const bin = typeof configuredBin === 'string' && configuredBin.length > 0
    ? configuredBin
    : execSync('command -v dsh', { encoding: 'utf8' }).trim()
  if (bin.length === 0) throw new Error('could not locate a dsh executable')
  return dirname(dirname(realpathSync(bin)))
}

/**
 * Resolve a module out of the installed DSH dependency tree.
 *
 * DSH ships as a bundle with its own nested dependencies, so its packages are
 * not reachable from this plugin's own resolution paths.
 */
export function resolveDshModule(spec) {
  const require = createRequire(join(resolveDshRoot(), 'package.json'))
  return require.resolve(spec)
}

/** Load the harness's own validators from the installed DSH dependency tree. */
export async function loadValidators() {
  const require = createRequire(join(resolveDshRoot(), 'package.json'))
  const load = async (spec) => import(pathToFileURL(require.resolve(spec)).href)
  const persistence = await load('@deepseek-ai/dsh-session-persistence')
  const session = await load('@deepseek-ai/dsh-session')
  if (typeof persistence.validateStoredEvents !== 'function') {
    throw new Error('installed DSH does not export validateStoredEvents; cannot verify')
  }
  if (typeof session.Session?.create !== 'function') {
    throw new Error('installed DSH does not export Session.create; cannot verify resumability')
  }
  return { validateStoredEvents: persistence.validateStoredEvents, Session: session.Session }
}

/**
 * Read one standard zstd frame's exact byte length from its header and blocks.
 *
 * A frame's magic is not unique: it may occur in a compressed block. Parsing
 * the frame header and each three-byte block header is deterministic and works
 * on every Node version that exposes `zstdDecompressSync`.
 */
function frameLength(buf, start) {
  let offset = start
  const requireBytes = (count, what) => {
    if (offset + count > buf.length) throw new Error(`truncated zstd ${what} at byte ${offset}`)
  }
  requireBytes(5, 'frame header')
  if (!buf.subarray(offset, offset + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    throw new Error(`invalid zstd frame magic at byte ${offset}`)
  }
  offset += ZSTD_MAGIC.length
  const descriptor = buf[offset++]
  // Bits 4 and 3 are reserved/unused in a standard frame and must be zero.
  if ((descriptor & 0x18) !== 0) throw new Error(`invalid zstd frame descriptor at byte ${start + 4}`)
  const singleSegment = (descriptor & 0x20) !== 0
  const fcsFlag = descriptor >>> 6
  const dictionaryFlag = descriptor & 0x03
  if (!singleSegment) {
    requireBytes(1, 'window descriptor')
    offset += 1
  }
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag]
  requireBytes(dictionaryBytes, 'dictionary id')
  offset += dictionaryBytes
  const contentSizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  requireBytes(contentSizeBytes, 'content size')
  offset += contentSizeBytes

  while (true) {
    requireBytes(3, 'block header')
    const blockHeader = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
    // Raw and compressed blocks carry blockSize bytes. An RLE block stores one
    // byte which is repeated blockSize times.
    const payloadBytes = blockType === 1 ? 1 : blockSize
    requireBytes(payloadBytes, 'block payload')
    offset += payloadBytes
    if (!lastBlock) continue
    if ((descriptor & 0x04) !== 0) {
      requireBytes(4, 'content checksum')
      offset += 4
    }
    return offset - start
  }
}

/** Decode every zstd frame of a session log into a list of plaintext frames. */
export function decodeFrames(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < ZSTD_MAGIC.length) throw new Error('no zstd frame found')
  const chunks = []
  let offset = 0
  while (offset < buf.length) {
    if (!buf.subarray(offset, offset + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      throw new Error(`invalid zstd frame boundary at byte ${offset}`)
    }
    const length = frameLength(buf, offset)
    const end = offset + length
    try {
      chunks.push(zstdDecompressSync(buf.subarray(offset, end)).toString('utf8'))
    } catch (error) {
      throw new Error(`invalid zstd frame at byte ${offset}: ${error.message}`, { cause: error })
    }
    offset = end
  }
  return chunks
}

/** Detect an attachment block regardless of JSON whitespace or nesting. */
function containsImage(body) {
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    try {
      const value = JSON.parse(line)
      const visit = (node) => {
        if (node === null || typeof node !== 'object') return false
        if (Array.isArray(node)) return node.some(visit)
        if (node.type === 'image') return true
        return Object.values(node).some(visit)
      }
      if (visit(value)) return true
    } catch {
      // Structural verification reports malformed JSON elsewhere; image
      // detection is only a conservative overwrite guard.
    }
  }
  return false
}

/**
 * Read an installed session log far enough to tell whether it is still exactly
 * the file this importer wrote.
 *
 * The frame count is the load-bearing signal: this importer writes a session as
 * two frames (header, then the whole event stream in one batch), while the
 * running harness appends one frame per event batch. A log with more than two
 * frames is therefore one the user has since continued, and rewriting it would
 * delete their turns.
 *
 * @returns `{frames, events, bodySha256}` — the body hash covers every frame
 *   after the header, so it changes both when the importer writes different
 *   content and when the harness appends to it.
 */
export function readSessionLog(path) {
  const frames = decodeFrames(readFileSync(path))
  const body = frames.slice(1).join('')
  return {
    frames: frames.length,
    events: body.split('\n').filter((line) => line.length > 0).length,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    // Used as a guard, not as content: a conversion that could not reach the
    // attachment store must not overwrite a log that does hold images.
    hasImages: containsImage(body),
  }
}

/**
 * Assert every tool result can be answered by an assistant `tool-call` block.
 *
 * Mirrors what the provider adapter does when it serializes history: assistant
 * content supplies `tool_calls`; each `tool/result` becomes a `role: "tool"`
 * message that must follow one.
 */
export function assertToolCallPairing(events) {
  /** callIds declared by assistant messages and not yet answered. */
  const declared = new Set()
  const answered = new Set()
  const calls = new Set()
  let declaredSeq = -1
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call') {
          declared.add(block.id)
          declaredSeq = event.seq
        }
      }
      continue
    }
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      if (!declared.has(callId) || answered.has(callId) || calls.has(callId)) {
        throw new Error(
          `tool/call ${callId} (seq ${event.seq}) has no matching assistant "tool-call" block; `
          + 'the provider would reject its result as an orphaned tool message',
        )
      }
      calls.add(callId)
      continue
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.content?.[0]?.toolCallId ?? event.data?.message?.source?.callId
      if (!declared.has(callId) || answered.has(callId)) {
        throw new Error(
          `tool/result for ${callId} (seq ${event.seq}) follows no assistant "tool-call" block `
          + `(last declaring assistant message: ${declaredSeq === -1 ? 'none' : `seq ${declaredSeq}`}); `
          + 'continuing this session would fail with "Messages with role \'tool\' must be a response '
          + 'to a preceding message with \'tool_calls\'"',
        )
      }
      answered.add(callId)
    }
  }
  const unanswered = [...calls].filter((callId) => !answered.has(callId))
  if (unanswered.length > 0) {
    throw new Error(
      `tool call(s) ${unanswered.join(', ')} have no result; continuing this session would leave `
      + 'an unanswered provider tool call',
    )
  }
}

/**
 * Verify one session log against all three checks.
 * @returns the parsed header and event count.
 */
export function verifyLog(path, validators) {
  const frames = decodeFrames(readFileSync(path))
  const first = frames[0]
  const headerLines = first.split('\n').filter((line) => line.length > 0)
  if (headerLines.length !== 1 || first.indexOf('\n') !== first.length - 1) {
    throw new Error('first zstd frame is not exactly one header line')
  }
  const lines = frames.join('').split('\n').filter((l) => l.length > 0)
  const header = JSON.parse(lines[0])
  const events = lines.slice(1).map((l) => JSON.parse(l))
  if (header.type !== 'session') throw new Error(`first record is "${header.type}", not a session header`)
  validators.validateStoredEvents({ id: header.id }, events, path)
  validators.Session.create(header.id, events, header)
  assertToolCallPairing(events)
  return { header, events: events.length }
}

/** Find every session log at or below a path. */
export function findLogs(target, out = []) {
  if (typeof target !== 'string' || target.length === 0) return out
  let targetStat
  try {
    targetStat = lstatSync(target)
  } catch {
    // The caller reports an empty/inaccessible selection rather than following
    // a dangling path.
    return out
  }
  if (targetStat.isSymbolicLink()) return out
  if (targetStat.isFile()) {
    if (basename(target) === 'session.v3.jsonl.zstd') out.push(target)
    return out
  }
  if (!targetStat.isDirectory()) return out
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) findLogs(full, out)
    else if (entry.isFile() && entry.name === 'session.v3.jsonl.zstd') out.push(full)
  }
  return out
}

/**
 * Verify every log under the given paths.
 * @returns `{passed, failed, events, failures}`; throws when nothing was found,
 *   so an empty selection can never be reported as success.
 */
export async function verifyPaths(targets, { quiet = false } = {}) {
  const validators = await loadValidators()
  const logs = targets.flatMap((t) => findLogs(t)).sort()
  if (logs.length === 0) {
    throw new Error(`no session.v3.jsonl.zstd found under: ${targets.join(', ')}`)
  }
  let passed = 0
  let events = 0
  const failures = []
  for (const log of logs) {
    try {
      const { header, events: count } = verifyLog(log, validators)
      passed += 1
      events += count
      if (!quiet) console.log(`  OK    ${String(header.id).slice(0, 28)}  ${String(count).padStart(5)} events  ${header.cwd ?? ''}`)
    } catch (error) {
      failures.push({ log, message: String(error.message).slice(0, 240) })
      if (!quiet) console.log(`  FAIL  ${log.slice(-60)}  ${String(error.message).slice(0, 200)}`)
    }
  }
  return { passed, failed: failures.length, events, failures }
}
