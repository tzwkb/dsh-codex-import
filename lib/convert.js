/**
 * Codex rollout → DSH session conversion.
 *
 * Codex stores one conversation across one or more `rollout-*.jsonl` segments
 * sharing a `session_id`; segments are time-contiguous, so ordering every
 * record by timestamp (then `ordinal`) reproduces it without duplication.
 *
 * The DSH side is stricter than it looks, and each rule below was found by
 * running the harness's own validators rather than by reading the format:
 *
 *  1. `assistant/message` is surface-eligible → needs a top-level `surfaceOp`.
 *  2. Every message event needs a non-empty string `id`.
 *  3. `assistant/message` needs numeric `turn`, numeric `step`, and a `stream`
 *     Array (`assertAssistantSettlementShape`), or it resumes nowhere.
 *  4. The provider derives `tool_calls` from `tool-call` **content blocks** on
 *     the assistant message, NOT from the `tool/call` event. An assistant
 *     message must therefore carry a `tool-call` block for every call whose
 *     result appears, or the next turn fails with "Messages with role 'tool'
 *     must be a response to a preceding message with 'tool_calls'".
 *
 * @module dsh-codex-import/convert
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ROLLOUT_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/

/** Codex home, honoring CODEX_HOME. */
export function codexSessionsRoot() {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'sessions')
    : join(homedir(), '.codex', 'sessions')
}

// ── DSH path encoding (mirrors dsh-session-persistence-jsonl) ────────────────

/** Escape one path segment the way DSH stores session ids. */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Build DSH's human-navigable project directory key for a cwd. */
export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    const code = ch.charCodeAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * List rollout files whose **filename** timestamp falls in the window. File
 * mtime is not a recency signal: Codex rewrites old rollouts, so a months-old
 * conversation can carry today's mtime.
 */
export function findRollouts(sinceHours, root = codexSessionsRoot()) {
  const cutoff = Date.now() - sinceHours * 3600_000
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const m = ROLLOUT_RE.exec(entry.name)
        if (m === null) continue
        const stamp = new Date(
          Number(m[1]), Number(m[2]) - 1, Number(m[3]),
          Number(m[4]), Number(m[5]), Number(m[6]),
        ).getTime()
        if (stamp >= cutoff) found.push({ path: full, stamp })
      }
    }
  }
  walk(root)
  return found
}

/** Read one rollout file into parsed records, skipping unparsable lines. */
function readRecords(path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A truncated tail line is expected on a live rollout.
    }
  }
  return out
}

/**
 * Read only the first record of a rollout file.
 *
 * `session_meta` is always the first line (verified across the corpus), and it
 * carries the `session_id`, so id filtering can skip the other 4.5 GB. The
 * filename suffix looks like a session id but is NOT one — across a 300-file
 * sample it matched `session_meta.session_id` only 8% of the time — so the id
 * must come from the record, never from the name.
 *
 * @returns the parsed first record, or undefined when the file has none.
 */
function readFirstRecord(path) {
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    const read = readSync(fd, chunk, 0, chunk.length, 0)
    const slice = chunk.subarray(0, read)
    const nl = slice.indexOf(10)
    const line = slice.subarray(0, nl === -1 ? read : nl).toString('utf8')
    if (line.length === 0) return undefined
    return JSON.parse(line)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

// ── Codex record helpers ─────────────────────────────────────────────────────

/** Extract plain text from a Codex content array. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}

/** Extract plain text from a tool-output payload. */
function outputText(payload) {
  const out = payload.output
  if (typeof out === 'string') return out
  return textOf(out)
}

/**
 * Plaintext reasoning summaries. Codex ships the model's thinking as an
 * encrypted Fernet blob no client can read; `summary` is the only readable
 * residue and is populated for roughly a third of reasoning records.
 */
function reasoningSummary(payload) {
  const summary = payload.summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
    .filter((t) => t.length > 0)
    .join('\n\n')
}

/** Render a tool-search result as readable text. */
function toolSearchText(payload) {
  const tools = payload.tools
  if (!Array.isArray(tools)) return ''
  return tools
    .map((t) => {
      const name = t?.name ?? t?.type ?? 'tool'
      const desc = typeof t?.description === 'string' ? ` — ${t.description}` : ''
      return `- ${name}${desc}`
    })
    .join('\n')
}

/**
 * Codex records its own machine context as `role: "user"` items, which would
 * otherwise open the session and drive the derived title. A human prompt never
 * starts with one of these tags.
 */const INJECTED_TAG = /^\s*<(recommended_plugins|environment_context|skill|turn_aborted|in-app-browser-context|app-context|user_instructions|agents_md)\b/
const AGENTS_MD_HEADING = /^\s*#\s*AGENTS\.md instructions\b/
const FILES_MENTIONED = /^\s*#\s*Files mentioned by the user:/
const MY_REQUEST = /##\s*My request for Codex:\s*/

/**
 * Strip Codex's own context injection from a user message.
 * @returns the user's text, or undefined when the message is pure scaffolding.
 */
function userText(text) {
  if (INJECTED_TAG.test(text) || AGENTS_MD_HEADING.test(text)) return undefined
  if (FILES_MENTIONED.test(text)) {
    const parts = text.split(MY_REQUEST)
    return parts.length > 1 ? parts[parts.length - 1].trim() : text.trim()
  }
  return text
}

// ── images ───────────────────────────────────────────────────────────────────

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s

/**
 * Decode one Codex image data URL.
 * @returns `{bytes, mediaType, key}` — `key` is the sha256 of the ORIGINAL
 *   bytes and exists only to match a pre-pass against the builder. The durable
 *   reference comes from the attachment store, which re-normalizes the image,
 *   so the key is never itself a stored identifier.
 */
function decodeDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' ? DATA_URL_RE.exec(dataUrl) : null
  if (match === null) return undefined
  let bytes
  try {
    bytes = Buffer.from(match[2], 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0) return undefined
  return { bytes, mediaType: match[1], key: createHash('sha256').update(bytes).digest('hex') }
}

/** Every image in a Codex content array, in order. */
function imagesOf(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block?.type !== 'input_image') continue
    const decoded = decodeDataUrl(block.image_url)
    if (decoded !== undefined) out.push(decoded)
  }
  return out
}

/** Every distinct image across a set of conversations, keyed by content hash. */
export function collectImages(conversations) {
  const unique = new Map()
  const note = (content) => {
    for (const image of imagesOf(content)) {
      if (!unique.has(image.key)) unique.set(image.key, { bytes: image.bytes, mediaType: image.mediaType })
    }
  }
  for (const convo of conversations) {
    for (const segment of convo.segments) {
      for (const record of segment.records) {
        if (record.type === 'response_item' && record.payload?.type === 'message') note(record.payload.content)
        // A compaction carries history that may exist nowhere else.
        else if (record.type === 'compacted') {
          for (const entry of record.payload?.replacement_history ?? []) note(entry?.content)
        }
      }
    }
  }
  return unique
}

// ── conversion ───────────────────────────────────────────────────────────────

/**
 * Build the ordered DSH record list for one merged conversation.
 *
 * Shape: turn/start → step/start → (user/message)* → assistant/message →
 * (tool/call → tool/result)* → step/end → turn/end. One step is one model
 * invocation; a step whose model response was tool calls carries them as
 * `tool-call` content blocks on its assistant message.
 */
export function buildRecords(segments, sessionId, opts = {}) {
  const maxToolOutput = opts.maxToolOutput ?? 0
  /** Content-hash → durable attachment reference; empty means images are skipped. */
  const imageRefs = opts.imageRefs ?? new Map()
  const all = []
  for (const seg of segments) for (const r of seg.records) all.push(r)
  all.sort((a, b) => {
    const ta = String(a.timestamp ?? '')
    const tb = String(b.timestamp ?? '')
    if (ta !== tb) return ta.localeCompare(tb)
    return (a.ordinal ?? 0) - (b.ordinal ?? 0)
  })

  const meta = all.find((r) => r.type === 'session_meta')?.payload ?? {}
  const cwd = meta.cwd ?? process.cwd()
  const provider = meta.model_provider ?? 'openai'
  const model = meta.model ?? 'codex'
  const first = all.find((r) => typeof r.timestamp === 'string')
  const createdAt = first ? Date.parse(first.timestamp) : Date.now()
  const id = `session-${sessionId}`

  const records = []
  let seq = 0
  let time = createdAt
  const push = (type, data, extra) => {
    records.push({ type, seq: seq++, time, data, ...extra })
  }
  const stamp = (r) => {
    const t = Date.parse(r.timestamp ?? '')
    if (Number.isFinite(t)) time = t
  }

  records.push({ type: 'session', version: 3, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })
  time = createdAt
  push('permission/preset', { preset: 'workspace-write' })
  push('sandbox/mode', { mode: 'workspace-write' })
  push('approval/policy', { policy: 'ask' })

  let turn = 0
  let step = 0
  let stepOpen = false
  let stepHasAssistant = false
  let stepHasToolResult = false
  let pendingReasoning = []
  /** Assistant message of the current tool-calling round, awaiting more calls. */
  let openCallMessage = null
  const callSeqs = new Map()
  const stats = { truncated: 0, reasoning: 0, injected: 0, toolCalls: 0, synthesized: 0, imagesImported: 0, imagesSkipped: 0, historyMessages: 0 }

  const openStep = () => {
    if (stepOpen) return
    step += 1
    push('step/start', { turn, step })
    stepOpen = true
    stepHasAssistant = false
    stepHasToolResult = false
    openCallMessage = null
  }
  const closeStep = () => {
    if (!stepOpen) return
    if (pendingReasoning.length > 0) emitAssistant([], pendingReasoning)
    push('step/end', { turn, step })
    stepOpen = false
    openCallMessage = null
  }
  const startModelCall = () => {
    if (stepOpen && (stepHasAssistant || stepHasToolResult)) closeStep()
    openStep()
  }
  const emitAssistant = (extraBlocks, reasoning) => {
    const message = {
      role: 'assistant',
      content: [
        ...reasoning.map((text) => ({ type: 'reasoning', text })),
        ...extraBlocks,
      ],
      source: { kind: 'model', provider, model },
      id: randomUUID(),
    }
    push('assistant/message', {
      turn,
      step,
      message,
      // Required by the restore path; see assertAssistantSettlementShape.
      stream: [],
    }, { surfaceOp: 'append' })
    stepHasAssistant = true
    return message
  }
  const beginTurn = () => {
    turn += 1
    step = 0
    closeStep()
    push('turn/start', { turn })
  }
  const endTurn = (reasonKind) => {
    closeStep()
    push('turn/end', { turn, reason: { kind: reasonKind } })
  }
  const clamp = (text) => {
    if (maxToolOutput <= 0 || text.length <= maxToolOutput) return text
    stats.truncated += 1
    return `${text.slice(0, maxToolOutput)}\n\n[... truncated ${text.length - maxToolOutput} of ${text.length} chars during Codex import ...]`
  }
  /**
   * Record a tool call. Every call must also appear as a `tool-call` block on
   * an assistant message, because that is where the provider reads
   * `tool_calls` from — a bare `tool/call` event leaves its result orphaned.
   */
  const pushToolCall = (callId, name, args) => {
    if (stepHasToolResult) closeStep()
    openStep()
    if (openCallMessage === null) {
      if (!stepHasAssistant) stats.synthesized += 1
      openCallMessage = emitAssistant([], pendingReasoning)
      pendingReasoning = []
    }
    openCallMessage.content.push({
      type: 'tool-call',
      id: callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    })
    push('tool/call', {
      turn,
      step,
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    })
    callSeqs.set(callId, records[records.length - 1].seq)
    stats.toolCalls += 1
  }
  const pushToolResult = (callId, text) => {
    openStep()
    const sourceSeq = callSeqs.get(callId)
    push('tool/result', {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: clamp(text) }], isError: false }],
        role: 'user',
        id: randomUUID(),
      },
    }, {
      surfaceOp: 'append',
      ...(sourceSeq === undefined ? {} : { sourceEventSeqs: [sourceSeq] }),
    })
    stepHasToolResult = true
    openCallMessage = null
  }

  let turnOpen = false

  /**
   * Identity of every message already present as a normal record. A compaction
   * history repeats most of what the log holds; only the remainder is new, and
   * emitting the repeats would duplicate the conversation.
   */
  const signature = (payload) => (typeof payload?.id === 'string' && payload.id.length > 0
    ? `id:${payload.id}`
    : `body:${payload?.role ?? ''}:${textOf(payload?.content)}`)
  const knownMessages = new Set()
  for (const record of all) {
    if (record.type === 'response_item' && record.payload?.type === 'message') {
      knownMessages.add(signature(record.payload))
    }
  }

  /**
   * Emit one Codex message. Shared by `response_item` messages and by the
   * history a `compacted` record carries.
   * @param payload - the message payload.
   * @param fromHistory - true when recovered from a compaction history.
   */
  const emitMessage = (payload, fromHistory) => {
    const role = payload.role
    const text = textOf(payload.content)
    const images = imagesOf(payload.content)
    const counted = () => {
      if (fromHistory) stats.historyMessages += 1
    }
    if (role === 'user') {
      const human = userText(text)
      const hasHuman = human !== undefined && human.length > 0
      // An image-only message must survive: the text test alone would drop it.
      if (!hasHuman && images.length === 0) {
        stats.injected += 1
        return
      }
      const blocks = []
      if (hasHuman) blocks.push({ type: 'text', text: human })
      for (const image of images) {
        const ref = imageRefs.get(image.key)
        if (ref === undefined) stats.imagesSkipped += 1
        else {
          blocks.push({ type: 'image', attachment: ref })
          stats.imagesImported += 1
        }
      }
      if (blocks.length === 0) {
        stats.injected += 1
        return
      }
      openStep()
      push('user/message', {
        content: blocks,
        source: { kind: 'user' },
        role: 'user',
        id: payload.id ?? randomUUID(),
      }, { surfaceOp: 'append' })
      counted()
      return
    }
    if (role === 'assistant') {
      if (text.length === 0) return
      startModelCall()
      emitAssistant([{ type: 'text', text }], pendingReasoning)
      pendingReasoning = []
      openCallMessage = null
      counted()
    }
    // role "developer" is Codex app context, not user content.
  }

  for (const r of all) {
    const payload = r.payload ?? {}
    stamp(r)

    if (r.type === 'event_msg' && payload.type === 'task_started') {
      if (turnOpen) endTurn('completed')
      beginTurn()
      turnOpen = true
      continue
    }
    if (r.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      if (turnOpen) {
        const failed = payload.type === 'task_complete' && payload.error !== undefined && payload.error !== null
        endTurn(payload.type === 'turn_aborted' || failed ? 'interrupted' : 'completed')
      }
      turnOpen = false
      continue
    }
    // A compaction carries the conversation history as of that point. Most of
    // it repeats what the log already holds, but part of it exists nowhere
    // else: dropping the whole record silently loses real turns.
    if (r.type === 'compacted') {
      if (!turnOpen) {
        beginTurn()
        turnOpen = true
      }
      for (const entry of payload.replacement_history ?? []) {
        // `compaction` markers carry no conversation content.
        if (entry?.type !== 'message') continue
        const key = signature(entry)
        if (knownMessages.has(key)) continue
        knownMessages.add(key)
        emitMessage(entry, true)
      }
      continue
    }
    // `world_state`, `turn_context`, `token_usage_record` and
    // `inter_agent_communication_metadata` are context plumbing, not transcript.
    if (r.type !== 'response_item') continue

    if (!turnOpen) {
      beginTurn()
      turnOpen = true
    }

    switch (payload.type) {
      case 'message': {
        emitMessage(payload, false)
        break
      }
      case 'reasoning': {
        const text = reasoningSummary(payload)
        if (text.length === 0) break
        if (openCallMessage === null) startModelCall()
        pendingReasoning.push(text)
        stats.reasoning += 1
        break
      }
      case 'function_call':
      case 'custom_tool_call': {
        pushToolCall(payload.call_id ?? payload.id, payload.name ?? 'tool', payload.arguments ?? payload.input ?? '')
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        pushToolResult(payload.call_id ?? payload.id, outputText(payload))
        break
      }
      case 'tool_search_call': {
        pushToolCall(payload.call_id ?? payload.id, 'tool_search', payload.arguments ?? {})
        break
      }
      case 'tool_search_output': {
        pushToolResult(payload.call_id ?? payload.id, toolSearchText(payload))
        break
      }
      case 'web_search_call': {
        pushToolCall(payload.call_id ?? payload.id, 'web_search', payload.action ?? {})
        break
      }
      case 'agent_message': {
        // Inter-agent envelope, mostly encrypted; DSH models delegation natively.
        break
      }
      default:
        break
    }
  }
  if (turnOpen) endTurn('completed')

  return { records, cwd, id, createdAt, provider, model, turnCount: turn, stats }
}

/** Group rollout files into conversations keyed by Codex session id. */
export function collectConversations(rollouts, sessionIds = []) {
  const bySession = new Map()
  for (const file of rollouts) {
    // The id filter is decided from the first record alone, so targeting a few
    // sessions by id never reads the rest of the corpus.
    const head = readFirstRecord(file.path)
    const headMeta = head?.type === 'session_meta' ? head.payload : undefined
    if (headMeta?.session_id === undefined) continue
    if (sessionIds.length > 0 && !sessionIds.includes(headMeta.session_id)) continue
    const records = readRecords(file.path)
    const meta = records.find((r) => r.type === 'session_meta')?.payload
    if (meta?.session_id === undefined) continue
    const firstTs = records.find((r) => typeof r.timestamp === 'string')?.timestamp ?? ''
    if (!bySession.has(meta.session_id)) bySession.set(meta.session_id, { sessionId: meta.session_id, segments: [] })
    bySession.get(meta.session_id).segments.push({ path: file.path, records, firstTs })
  }
  for (const convo of bySession.values()) {
    convo.segments.sort((a, b) => a.firstTs.localeCompare(b.firstTs))
  }
  return [...bySession.values()].sort((a, b) => a.segments[0].firstTs.localeCompare(b.segments[0].firstTs))
}

/**
 * Inventory Codex conversations without converting anything, so a scope can be
 * chosen before committing to an import.
 *
 * @returns one row per conversation: id, time span, segment count, cwd, and the
 *   short user prompts that identify it in a list.
 */
export function listConversations({ sinceHours = 24, codexRoot } = {}) {
  const rollouts = findRollouts(sinceHours, codexRoot)
  const rows = []
  for (const convo of collectConversations(rollouts, [])) {
    const all = convo.segments.flatMap((s) => s.records)
    const meta = all.find((r) => r.type === 'session_meta')?.payload ?? {}
    const prompts = all
      .filter((r) => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user')
      .map((r) => userText(textOf(r.payload.content)))
      .filter((t) => t !== undefined && t.length > 0)
    rows.push({
      sessionId: convo.sessionId,
      cwd: meta.cwd ?? '',
      segments: convo.segments.length,
      startedAt: convo.segments[0].firstTs,
      lastAt: all.at(-1)?.timestamp ?? convo.segments[0].firstTs,
      prompt: (prompts[0] ?? '').replace(/\s+/g, ' ').slice(0, 70),
      prompts: prompts.length,
    })
  }
  return { rollouts: rollouts.length, rows }
}

/**
 * Serialize one built session into the physical log the jsonl backend reads:
 * frame 1 is exactly the header line, frame 2+ carries the event stream.
 * Decoding the first frame must yield one newline-terminated line.
 */
export function serializeSession(built) {
  const [headerRecord, ...eventRecords] = built.records
  const headerFrame = `${JSON.stringify(headerRecord)}\n`
  const bodyFrame = `${eventRecords.map((r) => JSON.stringify(r)).join('\n')}\n`
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerFrame, 'utf8')),
    zstdCompressSync(Buffer.from(bodyFrame, 'utf8')),
  ])
}

/** Absolute directory one built session occupies under a sessions root. */
export function sessionDirFor(built, root) {
  return join(root, projectKey(built.cwd), encodeSegment(built.id))
}

/**
 * Convert and write conversations under `root`.
 * @returns per-session summaries plus the aggregate totals.
 */
/**
 * Admit every distinct image through the attachment store.
 *
 * This must run before `buildRecords`, which is synchronous: the durable
 * reference can only come from the store, and the store normalizes the bytes
 * (re-encoding to WebP and re-hashing), so it cannot be reconstructed from the
 * Codex payload. Images are admitted one at a time so a single refused image
 * (unsupported type, oversized, too many pixels) costs that image only.
 *
 * @param conversations - collected conversations.
 * @param saveImages - store entry, `async (inputs) => refs`.
 * @returns content-hash → reference, plus the refusals.
 */
async function admitImages(conversations, saveImages) {
  const refs = new Map()
  const refusals = []
  if (saveImages === undefined) return { refs, refusals }
  for (const [key, image] of collectImages(conversations)) {
    try {
      const [ref] = await saveImages([{ data: image.bytes, mediaType: image.mediaType }])
      if (ref === undefined) throw new Error('store returned no reference')
      refs.set(key, ref)
    } catch (error) {
      refusals.push({ key, mediaType: image.mediaType, reason: String(error?.message ?? error) })
    }
  }
  return { refs, refusals }
}

/**
 * Convert and write conversations under `root`.
 *
 * @param saveImages - optional attachment-store entry. Without it (a standalone
 *   CLI has no store) images are skipped and counted rather than silently lost.
 * @returns per-session summaries plus the aggregate totals.
 */
export async function runImport({
  root, sinceHours = 24, sessionIds = [], maxToolOutput = 0,
  dryRun = false, codexRoot, saveImages,
}) {
  const rollouts = findRollouts(sessionIds.length > 0 ? Number.MAX_SAFE_INTEGER : sinceHours, codexRoot)
  const conversations = collectConversations(rollouts, sessionIds)
  const { refs: imageRefs, refusals: imageRefusals } = await admitImages(conversations, saveImages)

  const results = []
  for (const convo of conversations) {
    const built = buildRecords(convo.segments, convo.sessionId, { maxToolOutput, imageRefs })
    const dir = sessionDirFor(built, root ?? '/dev/null')
    if (!dryRun) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'session.v3.jsonl.zstd'), serializeSession(built), { mode: 0o600 })
    }
    results.push({
      id: built.id,
      cwd: built.cwd,
      dir,
      segments: convo.segments.length,
      records: built.records.length,
      turns: built.turnCount,
      stats: built.stats,
    })
  }
  return { rollouts: rollouts.length, results, imagesAvailable: imageRefs.size, imageRefusals }
}
