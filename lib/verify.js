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
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Locate the installed DSH package root via the `dsh` executable. */
export function resolveDshRoot() {
  const bin = execSync('command -v dsh', { encoding: 'utf8' }).trim()
  return dirname(dirname(realpathSync(bin)))
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

/** Decode every zstd frame of a session log into a list of plaintext frames. */
export function decodeFrames(buf) {
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i)
    i += 4
  }
  if (offsets.length === 0) throw new Error('no zstd frame found')
  const chunks = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    chunks.push(zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8'))
  }
  return chunks
}

/**
 * Assert every tool result can be answered by an assistant `tool-call` block.
 *
 * Mirrors what the provider adapter does when it serializes history: assistant
 * content supplies `tool_calls`; each `tool/result` becomes a `role: "tool"`
 * message that must follow one.
 */
export function assertToolCallPairing(events) {
  /** callIds declared by the assistant message of the current step. */
  let declared = new Set()
  let declaredSeq = -1
  let pending = new Map()
  for (const event of events) {
    if (event.type === 'step/start') {
      declared = new Set()
      declaredSeq = -1
      continue
    }
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
      pending.set(event.data.callId, event.seq)
      if (!declared.has(event.data.callId)) {
        throw new Error(
          `tool/call ${event.data.callId} (seq ${event.seq}) has no matching assistant "tool-call" block; `
          + 'the provider would reject its result as an orphaned tool message',
        )
      }
      continue
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.content?.[0]?.toolCallId ?? event.data?.message?.source?.callId
      if (!declared.has(callId)) {
        throw new Error(
          `tool/result for ${callId} (seq ${event.seq}) follows no assistant "tool-call" block `
          + `(last declaring assistant message: ${declaredSeq === -1 ? 'none' : `seq ${declaredSeq}`}); `
          + 'continuing this session would fail with "Messages with role \'tool\' must be a response '
          + 'to a preceding message with \'tool_calls\'"',
        )
      }
      pending.delete(callId)
    }
  }
}

/**
 * Verify one session log against all three checks.
 * @returns the parsed header and event count.
 */
export function verifyLog(path, validators) {
  const frames = decodeFrames(readFileSync(path))
  const first = frames[0]
  if (first.length === 0 || first.indexOf('\n') !== first.length - 1) {
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
  if (target.endsWith('session.v3.jsonl.zstd')) {
    out.push(target)
    return out
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    if (entry.isDirectory()) findLogs(full, out)
    else if (entry.name === 'session.v3.jsonl.zstd') out.push(full)
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
