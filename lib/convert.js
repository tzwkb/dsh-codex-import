/**
 * Codex rollout → DSH session conversion.
 *
 * Codex stores one conversation across one or more `rollout-*.jsonl` segments
 * (and, in newer builds, `.jsonl.zst` files). Legacy segments share a
 * `session_id`; newer segments carry an id/lineage pair. The inventory resolves
 * that root before this builder orders records by timestamp and `ordinal`.
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
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib'
import { join, isAbsolute } from 'node:path'
import {
  textOf, outputText, outputIsError, reasoningSummary, toolSearchText, collectToolOutcomes,
  customToolArguments,
} from './codex-payload.js'
import {
  codexSessionsRoot, findRollouts, stringId, projectMatches, timestampOrder,
} from './codex-discovery.js'
import {
  collectConversationRefs, iterateConversations, collectConversations, listConversations,
} from './codex-inventory.js'
import {
  normalizeMessageContent, inlineToolBlocks, appMessagePayload, itemFailed,
  userText, fallbackTitle, eventUserPayload,
} from './codex-message.js'
import { admitImages, generatedImageOf, imagesOf } from './codex-images.js'
export { codexSessionsRoot, findRollouts } from './codex-discovery.js'
export { collectImages } from './codex-images.js'
export {
  collectConversationRefs, iterateConversations, collectConversations, listConversations,
} from './codex-inventory.js'
// Match dsh-session-persistence-jsonl's checksummed frames. A checksum makes
// a copied session fail closed if its bytes are damaged in transit.
const ZSTD_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

// ── DSH path encoding (mirrors dsh-session-persistence-jsonl) ────────────────

/** Escape one path segment the way DSH stores session ids. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  // Iterate UTF-16 code units, exactly as dsh-session-persistence does. Using
  // `for…of` would combine astral characters and lose the low surrogate (and
  // would not be injective for lone surrogates).
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Build DSH's human-navigable project directory key for a cwd. */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
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

// ── conversion ───────────────────────────────────────────────────────────────

const lifecycleType = (value) => String(value ?? '').toLowerCase().replace(/[_-]/g, '')
const TURN_START_TYPES = new Set(['taskstarted', 'taskstart', 'turnstarted', 'turnstart', 'turnbegin'])
const TURN_END_TYPES = new Set(['taskcomplete', 'taskcompleted', 'taskend', 'turncomplete', 'turncompleted', 'turnend', 'turnended', 'turnaborted', 'taskaborted', 'turncancelled', 'turncanceled'])
const TURN_ABORT_TYPES = new Set(['turnaborted', 'taskaborted', 'turncancelled', 'turncanceled'])

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
  if (!Number.isSafeInteger(maxToolOutput) || maxToolOutput < 0) {
    throw new Error('maxToolOutput must be zero or a positive integer')
  }
  /** Content-hash → durable attachment reference; empty means images are skipped. */
  const imageRefs = opts.imageRefs ?? new Map()
  const all = []
  for (const [segmentIndex, seg] of segments.entries()) {
    for (const [recordIndex, record] of (seg.records ?? []).entries()) {
      // Keep provenance for conservative cross-segment dedupe without leaking
      // private fields into the serialized source record or digest.
      const copy = { ...record }
      Object.defineProperties(copy, {
        __segmentIndex: { value: segmentIndex, enumerable: false },
        __recordIndex: { value: recordIndex, enumerable: false },
      })
      all.push(copy)
    }
  }
  // The telemetry stream normally mirrors a response_item user message, but a
  // crash can flush only an event_msg user_message. Materialize a synthetic
  // response item for that case so the regular message state machine, title
  // logic, and image handling all remain in one path.
  const responseUserTexts = new Set()
  for (const record of all) {
    if (record?.type !== 'response_item') continue
    const payload = record.payload
    const role = payload?.role ?? (payload?.type === 'userMessage' ? 'user' : undefined)
    if (role !== 'user') continue
    const content = normalizeMessageContent(payload.content
      ?? (payload.text === undefined ? [] : [{ type: 'text', text: payload.text }]))
    const text = userText(textOf(content))
    if (text !== undefined && text.trim().length > 0) responseUserTexts.add(text.trim())
  }
  const telemetryUserKeys = new Set()
  const syntheticUsers = []
  for (const record of all) {
    if (record?.type !== 'event_msg') continue
    const normalized = eventUserPayload(record.payload)
    if (normalized === undefined) continue
    const text = userText(normalized.text)
    const key = text?.trim()
    const turnKey = stringId(record.payload?.turn_id ?? record.payload?.turnId)
      ?? String(record.timestamp ?? record.ordinal ?? '')
    const telemetryKey = `${turnKey}\u0000${key}`
    if (key === undefined || key.length === 0 || responseUserTexts.has(key) || telemetryUserKeys.has(telemetryKey)) continue
    telemetryUserKeys.add(telemetryKey)
    const synthetic = {
      timestamp: record.timestamp,
      ordinal: typeof record.ordinal === 'number' ? record.ordinal - 0.001 : record.ordinal,
      type: 'response_item',
      payload: normalized.payload,
    }
    Object.defineProperties(synthetic, {
      __segmentIndex: { value: record.__segmentIndex, enumerable: false },
      __recordIndex: { value: (record.__recordIndex ?? 0) - 0.001, enumerable: false },
      __telemetryFallback: { value: true, enumerable: false },
    })
    syntheticUsers.push(synthetic)
  }
  all.push(...syntheticUsers)
  // Fork/resume rollouts can be cumulative: the same response item is flushed
  // into more than one segment. Fold exact records and explicit message ids
  // before ordering, while retaining repeated id-less prompts (which can be
  // legitimate user turns). This is deliberately conservative so a repeated
  // question is never discarded merely because its text matches.
  const seenRecords = new Set()
  const seenMessageIds = new Set()
  const seenMessageBodies = new Map()
  const deduped = []
  for (const record of all) {
    const payload = record?.payload
    const explicitMessageId = record?.type === 'response_item' && payload?.type === 'message'
      ? stringId(payload.id) : undefined
    let structuralMessageKey
    if (record?.type === 'response_item' && payload?.type === 'message' && explicitMessageId === undefined) {
      try {
        structuralMessageKey = `${payload.role ?? ''}:${JSON.stringify(payload.content ?? null)}`
      } catch {
        structuralMessageKey = undefined
      }
    }
    const exact = (() => {
      try { return JSON.stringify(record) } catch { return undefined }
    })()
    if ((exact !== undefined && seenRecords.has(exact))
      || (explicitMessageId !== undefined && seenMessageIds.has(explicitMessageId))) continue
    if (structuralMessageKey !== undefined) {
      const previousSegment = seenMessageBodies.get(structuralMessageKey)
      if (previousSegment !== undefined && previousSegment !== record.__segmentIndex) continue
      seenMessageBodies.set(structuralMessageKey, record.__segmentIndex)
    }
    if (exact !== undefined) seenRecords.add(exact)
    if (explicitMessageId !== undefined) seenMessageIds.add(explicitMessageId)
    deduped.push(record)
  }
  const duplicateRecords = all.length - deduped.length
  all.length = 0
  all.push(...deduped)
  all.sort((a, b) => {
    const ta = timestampOrder(a.timestamp)
    const tb = timestampOrder(b.timestamp)
    if (ta !== tb) return ta - tb
    const sa = String(a.timestamp ?? '')
    const sb = String(b.timestamp ?? '')
    if (sa !== sb) return sa.localeCompare(sb)
    return (a.ordinal ?? 0) - (b.ordinal ?? 0)
  })
  const toolOutcomes = collectToolOutcomes(all)
  const generatedImageKeys = new Map()
  for (const record of all) {
    const payload = record?.payload
    const normalizedPayloadType = String(payload?.type ?? '').toLowerCase().replace(/[_-]/g, '')
    if (record?.type === 'response_item'
      && (normalizedPayloadType === 'imagegenerationcall'
        || normalizedPayloadType === 'imagegenerationcalloutput'
        || normalizedPayloadType === 'imagegenerationoutput'
        || normalizedPayloadType === 'imagegeneration')) {
      const callId = stringId(payload.call_id ?? payload.callId ?? payload.id ?? payload.item_id)
      const image = generatedImageOf(payload)
      if (callId !== undefined && image !== undefined) generatedImageKeys.set(callId, image.key)
    } else if (record?.type === 'event_msg') {
      const nested = payload?.event && typeof payload.event === 'object' ? payload.event
        : payload?.data && typeof payload.data === 'object' ? payload.data : payload
      const type = String(payload?.type ?? nested?.type ?? '').toLowerCase().replace(/[_-]/g, '')
      if (type.includes('imagegeneration')) {
        const callId = stringId(payload?.call_id ?? payload?.callId ?? payload?.item_id
          ?? nested?.call_id ?? nested?.callId ?? nested?.item_id)
        const image = generatedImageOf(payload) ?? generatedImageOf(nested)
        if (callId !== undefined && image !== undefined) generatedImageKeys.set(callId, image.key)
      }
    }
  }

  const metadata = all.filter((r) => r.type === 'session_meta' && r.payload !== null
    && typeof r.payload === 'object').map((r) => r.payload)
  const latestMeta = metadata.at(-1) ?? {}
  const firstMeta = metadata[0] ?? {}
  const turnContexts = all.filter((r) => r.type === 'turn_context' && r.payload !== null
    && typeof r.payload === 'object').map((r) => r.payload)
  const valueFromMeta = (key) => {
    const value = latestMeta[key]
    if (typeof value === 'string' && value.length > 0) return value
    const fallback = firstMeta[key]
    return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined
  }
  const contextValue = (key) => {
    for (const context of [...turnContexts].reverse()) {
      if (typeof context[key] === 'string' && context[key].length > 0) return context[key]
    }
    return undefined
  }
  const rawCwd = valueFromMeta('cwd') ?? contextValue('cwd')
  const cwd = typeof rawCwd === 'string' && isAbsolute(rawCwd) ? rawCwd : process.cwd()
  const provider = valueFromMeta('model_provider') ?? 'openai'
  const firstContextModel = turnContexts
    .map((context) => context.model ?? context.model_name)
    .find((value) => typeof value === 'string' && value.length > 0)
  const model = valueFromMeta('model') ?? contextValue('model') ?? 'codex'
  let activeModel = valueFromMeta('model') ?? firstContextModel ?? model
  const explicitTitle = (() => {
    const titleKeys = ['title', 'name', 'thread_name', 'session_name', 'preview']
    const candidates = []
    for (const payload of metadata) {
      for (const key of titleKeys) if (typeof payload[key] === 'string' && payload[key].trim().length > 0) candidates.push(payload[key])
    }
    for (const record of all) {
      if (record.type !== 'event_msg' || record.payload === null || typeof record.payload !== 'object') continue
      for (const key of titleKeys) if (typeof record.payload[key] === 'string' && record.payload[key].trim().length > 0) candidates.push(record.payload[key])
    }
    return candidates.length > 0 ? fallbackTitle(candidates.at(-1)) : ''
  })()
  const first = all.find((r) => typeof r.timestamp === 'string')
  const parsedCreatedAt = first ? Date.parse(first.timestamp) : NaN
  const createdAt = Number.isSafeInteger(parsedCreatedAt) && parsedCreatedAt >= 0 ? parsedCreatedAt : Date.now()
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

  /**
   * Deterministic message id, derived from the conversation id and the event's
   * `seq`.
   *
   * A random id is correct but not *stable*: re-importing the same conversation
   * would mint different ids for byte-identical content, so a refresh could
   * never be recognised as a no-op, and a refresh that only extends the
   * conversation would still churn every earlier id. Deriving the id from the
   * position makes conversion idempotent, which is what lets the importer
   * compare a fresh conversion against what is already installed. The shape
   * stays UUID-like (version 5, variant a) to match the rest of the store.
   */
  const stableId = () => {
    const h = createHash('sha256').update(`${sessionId}:${seq}`).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
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
  /** Calls whose Codex output has not appeared yet. */
  const pendingCalls = new Map()
  const stats = {
    truncated: 0, reasoning: 0, injected: 0, toolCalls: 0, synthesized: 0,
    repairedTools: 0, toolErrors: 0, imagesImported: 0, imagesSkipped: 0, historyMessages: 0,
    duplicateRecords, malformedToolArguments: 0, placeholderResults: 0,
  }
  let titleSeq
  let titleText = ''
  let assistantTextInTurn = false
  let generatedCall = 0
  const unnamedCallIds = []

  /** Keep malformed/missing Codex call ids from producing an invalid DSH log. */
  const resolveCallId = (raw, kind) => {
    if (typeof raw === 'string' && raw.trim().length > 0) return raw
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
    if (kind === 'result' && unnamedCallIds.length > 0) return unnamedCallIds.shift()
    generatedCall += 1
    return `codex-${kind}-${generatedCall}`
  }

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
    // A cancelled Codex run can flush a function_call but never its output.
    // Leave a deterministic error result so the DSH provider sees a balanced
    // tool exchange and the user can continue the imported session. A real
    // completion event with an intentionally empty output is preserved as a
    // successful empty result.
    for (const [callId, pending] of pendingCalls) {
      if (pending.turn !== turn || pending.step !== step) continue
      const outcome = toolOutcomes.get(callId)
      const text = outcome === undefined
        ? pending.generated
          ? `[Codex import: ${pending.toolName} completed without a textual output]`
          : '[Codex import: the tool call was recorded without an output]'
        : outcome.text
      pendingCalls.delete(callId)
      if (outcome === undefined && pending.generated) stats.placeholderResults += 1
      else stats.repairedTools += 1
      appendToolResult(callId, text, outcome === undefined ? !pending.generated : outcome.isError,
        pending.seq, pending.imageKey)
    }
    push('step/end', { turn, step })
    stepOpen = false
    openCallMessage = null
  }
  const startModelCall = () => {
    if (stepOpen && (stepHasAssistant || stepHasToolResult)) closeStep()
    openStep()
  }
  const emitAssistant = (extraBlocks, reasoning, sourceId, sourceModel = activeModel) => {
    const message = {
      role: 'assistant',
      content: [
        ...reasoning.map((text) => ({ type: 'reasoning', text })),
        ...extraBlocks,
      ],
      source: { kind: 'model', provider, model: sourceModel },
      id: stringId(sourceId) ?? stableId(),
    }
    push('assistant/message', {
      turn,
      step,
      message,
      // Required by the restore path; see assertAssistantSettlementShape.
      stream: [],
    }, { surfaceOp: 'append' })
    stepHasAssistant = true
    if (extraBlocks.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)) {
      assistantTextInTurn = true
    }
    return message
  }
  const beginTurn = () => {
    // Close any malformed/open predecessor before changing the turn number;
    // otherwise step/end would name the new turn with the old step number.
    closeStep()
    turn += 1
    step = 0
    assistantTextInTurn = false
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
  const appendToolResult = (callId, text, isError, sourceSeq, imageKey) => {
    const attachment = imageKey === undefined ? undefined : imageRefs.get(imageKey)
    if (imageKey !== undefined && attachment === undefined) stats.imagesSkipped += 1
    const content = [{ type: 'text', text: clamp(text) }]
    if (attachment !== undefined) {
      content.push({ type: 'image', attachment })
      stats.imagesImported += 1
    }
    push('tool/result', {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
        role: 'user',
        id: stableId(),
      },
    }, {
      surfaceOp: 'append',
      ...(sourceSeq === undefined ? {} : { sourceEventSeqs: [sourceSeq] }),
    })
    if (isError) stats.toolErrors += 1
    stepHasToolResult = true
    openCallMessage = null
  }
  /**
   * Record a tool call. Every call must also appear as a `tool-call` block on
   * an assistant message, because that is where the provider reads
   * `tool_calls` from — a bare `tool/call` event leaves its result orphaned.
   */
  const pushToolCall = (rawCallId, name, args, { resolved = false, generated = false, imageKey } = {}) => {
    const callId = resolved ? String(rawCallId) : resolveCallId(rawCallId, 'call')
    const toolName = typeof name === 'string' && name.trim().length > 0 ? name : 'codex_tool'
    if (!resolved && (typeof rawCallId !== 'string' || rawCallId.trim().length === 0)
      && !(typeof rawCallId === 'number' && Number.isFinite(rawCallId))) {
      unnamedCallIds.push(callId)
    }
    if (stepHasToolResult) closeStep()
    openStep()
    if (openCallMessage === null) {
      if (!stepHasAssistant) stats.synthesized += 1
      openCallMessage = emitAssistant([], pendingReasoning)
      pendingReasoning = []
    }
    const argumentText = typeof args === 'string' ? args : JSON.stringify(args ?? {})
    openCallMessage.content.push({
      type: 'tool-call',
      id: callId,
      name: toolName,
      arguments: argumentText,
    })
    push('tool/call', {
      turn,
      step,
      callId,
      name: toolName,
      arguments: argumentText,
    })
    callSeqs.set(callId, records[records.length - 1].seq)
    pendingCalls.set(callId, { turn, step, seq: records[records.length - 1].seq, generated, toolName, imageKey })
    stats.toolCalls += 1
    return callId
  }
  const pushToolResult = (rawCallId, text, failed = false, imageKey) => {
    const callId = resolveCallId(rawCallId, 'result')
    openStep()
    if (!callSeqs.has(callId)) {
      // Some interrupted Codex rollouts contain an output after the matching
      // call record was lost (or never flushed). A bare tool/result would pass
      // storage validation but make the next provider request fail. Materialise
      // a clearly named placeholder call so the history remains resumable.
      pushToolCall(callId, 'codex_orphaned_tool', {}, { resolved: true })
      stats.repairedTools += 1
    }
    const pending = pendingCalls.get(callId)
    const sourceSeq = callSeqs.get(callId)
    pendingCalls.delete(callId)
    const outcome = toolOutcomes.get(callId)
    const effectiveText = text.length > 0 || outcome?.hasOutput !== true ? text : outcome.text
    appendToolResult(callId, effectiveText, failed || outcome?.isError === true, sourceSeq,
      imageKey ?? pending?.imageKey ?? generatedImageKeys.get(callId))
  }

  let turnOpen = false
  let currentTurnId

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
    const content = normalizeMessageContent(payload.content)
    const text = textOf(content)
    const images = imagesOf(content)
    const embeddedCalls = inlineToolBlocks(content)
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
        id: typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : stableId(),
      }, { surfaceOp: 'append' })
      if (titleSeq === undefined && hasHuman) {
        const candidate = fallbackTitle(human)
        if (candidate.length > 0) {
          titleSeq = records[records.length - 1].seq
          titleText = candidate
        }
      }
      counted()
      return
    }
    if (role === 'assistant') {
      if (text.length === 0 && embeddedCalls.length === 0) return
      if (text.length > 0) {
        startModelCall()
        openCallMessage = emitAssistant([{ type: 'text', text }], pendingReasoning, payload.id)
        pendingReasoning = []
      }
      // Keep the assistant message open while appending inline tool-call
      // blocks. The provider derives its wire `tool_calls` from these blocks,
      // so preserving them is essential for a resumable imported step.
      for (const call of embeddedCalls) {
        pushToolCall(call.id, call.name, call.args)
      }
      if (embeddedCalls.length === 0) openCallMessage = null
      else if (text.length === 0) openCallMessage = null
      counted()
    }
    // role "developer" is Codex app context, not user content.
  }

  for (const r of all) {
    const payload = r.payload ?? {}
    stamp(r)

    if (r.type === 'turn_context') {
      const contextTurnId = stringId(payload.turn_id ?? payload.turnId)
      if (contextTurnId !== undefined && currentTurnId !== undefined && contextTurnId !== currentTurnId) {
        if (turnOpen) endTurn('completed')
        turnOpen = false
      }
      if (contextTurnId !== undefined) currentTurnId = contextTurnId
      const contextModel = payload.model ?? payload.model_name
      if (typeof contextModel === 'string' && contextModel.trim().length > 0) activeModel = contextModel.trim()
      continue
    }

    const eventLifecycle = r.type === 'event_msg' ? lifecycleType(payload.type) : ''
    if (r.type === 'event_msg' && TURN_START_TYPES.has(eventLifecycle)) {
      if (turnOpen) endTurn('completed')
      beginTurn()
      turnOpen = true
      currentTurnId = stringId(payload.turn_id ?? payload.turnId) ?? currentTurnId
      continue
    }
    if (r.type === 'event_msg' && TURN_END_TYPES.has(eventLifecycle)) {
      if (turnOpen) {
        // A crash can flush only the telemetry-side final message. Recover it
        // when no response_item assistant text made it to the rollout; when a
        // normal response exists this stays silent to avoid duplicating it.
        const lastMessage = typeof payload.last_agent_message === 'string' ? payload.last_agent_message
          : typeof payload.message === 'string' ? payload.message : ''
        if (lastMessage.trim().length > 0 && !assistantTextInTurn) {
          startModelCall()
          emitAssistant([{ type: 'text', text: lastMessage.trim() }], pendingReasoning)
          pendingReasoning = []
          openCallMessage = null
        }
        const failed = itemFailed(payload)
        endTurn(TURN_ABORT_TYPES.has(eventLifecycle) || failed ? 'interrupted' : 'completed')
      }
      turnOpen = false
      currentTurnId = undefined
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
      case 'userMessage': {
        emitMessage(appMessagePayload(payload, 'user'), false)
        break
      }
      case 'agentMessage':
      case 'plan': {
        emitMessage(appMessagePayload(payload, 'assistant'), false)
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
      {
        pushToolCall(payload.call_id ?? payload.id, payload.name ?? 'tool', payload.arguments ?? payload.input ?? '')
        break
      }
      case 'custom_tool_call': {
        const normalized = customToolArguments(payload.arguments ?? payload.input ?? '')
        if (normalized.fallback) stats.malformedToolArguments += 1
        pushToolCall(payload.call_id ?? payload.id, payload.name ?? 'tool', normalized.arguments)
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        pushToolResult(payload.call_id ?? payload.id, outputText(payload), outputIsError(payload))
        break
      }
      case 'commandExecution':
      case 'command_execution': {
        const callId = payload.call_id ?? payload.callId ?? payload.id
        const args = {
          command: payload.command ?? payload.action?.command ?? '',
          cwd: payload.cwd ?? payload.action?.cwd ?? payload.action?.working_directory ?? '',
        }
        pushToolCall(callId, 'codex_command', args)
        const output = payload.aggregatedOutput ?? payload.aggregated_output ?? payload.output ?? payload.result
        pushToolResult(callId, typeof output === 'string' ? output : outputText({ output }), itemFailed(payload))
        break
      }
      case 'fileChange':
      case 'file_change': {
        const callId = payload.call_id ?? payload.callId ?? payload.id
        pushToolCall(callId, 'codex_file_change', { changes: payload.changes ?? [] })
        const rawOutput = payload.output ?? payload.result ?? payload.changes
        const renderedOutput = rawOutput === undefined
          ? JSON.stringify({ status: payload.status ?? 'completed' })
          : typeof rawOutput === 'string'
            ? rawOutput
            : outputText({ output: rawOutput }) || JSON.stringify(rawOutput)
        pushToolResult(callId, renderedOutput, itemFailed(payload))
        break
      }
      case 'mcpToolCall':
      case 'mcp_tool_call': {
        const callId = payload.call_id ?? payload.callId ?? payload.id
        const server = payload.server ?? payload.serverName ?? 'mcp'
        const tool = payload.tool ?? payload.name ?? 'tool'
        pushToolCall(callId, `mcp__${server}__${tool}`, payload.arguments ?? payload.input ?? {})
        const output = payload.error?.message ?? (payload.result === null || payload.result === undefined
          ? payload.output : outputText({ output: payload.result }))
        pushToolResult(callId, typeof output === 'string' ? output : outputText({ output }), itemFailed(payload))
        break
      }
      case 'dynamicToolCall':
      case 'dynamic_tool_call': {
        const callId = payload.call_id ?? payload.callId ?? payload.id
        const namespace = typeof payload.namespace === 'string' && payload.namespace.length > 0
          ? `${payload.namespace}__` : ''
        pushToolCall(callId, `${namespace}${payload.tool ?? payload.name ?? 'dynamic_tool'}`, payload.arguments ?? payload.input ?? {})
        const output = payload.output ?? payload.result ?? payload.contentItems
        pushToolResult(callId, typeof output === 'string' ? output : outputText({ output }), itemFailed(payload))
        break
      }
      case 'webSearch':
      case 'web_search': {
        const callId = payload.call_id ?? payload.callId ?? payload.id
        pushToolCall(callId, 'web_search', payload.action ?? { query: payload.query ?? '' })
        const output = payload.result ?? payload.output ?? payload.action
        pushToolResult(callId, typeof output === 'string' ? output : outputText({ output }), itemFailed(payload))
        break
      }
      case 'local_shell_call':
      case 'shell_call': {
        pushToolCall(payload.call_id ?? payload.id, payload.type === 'shell_call' ? 'shell' : 'local_shell',
          payload.action ?? payload.arguments ?? {})
        break
      }
      case 'local_shell_call_output':
      case 'shell_call_output': {
        pushToolResult(payload.call_id ?? payload.id, outputText(payload), outputIsError(payload))
        break
      }
      case 'tool_search_call': {
        pushToolCall(payload.call_id ?? payload.id, 'tool_search', payload.arguments ?? {}, { generated: true })
        break
      }
      case 'tool_search_output': {
        pushToolResult(payload.call_id ?? payload.id, toolSearchText(payload), outputIsError(payload))
        break
      }
      case 'web_search_call': {
        pushToolCall(payload.call_id ?? payload.id, 'web_search', payload.action ?? {}, { generated: true })
        break
      }
      case 'image_generation_call':
      case 'imageGenerationCall': {
        // Codex's image-generation item often has no separate output item. Keep
        // a balanced successful placeholder; a later completion event/output
        // still replaces it with the real text through the normal outcome map.
        pushToolCall(payload.call_id ?? payload.id, 'image_generation',
          payload.action ?? payload.arguments ?? payload.input ?? {}, {
            generated: true,
            imageKey: generatedImageOf(payload)?.key,
          })
        break
      }
      case 'image_generation_call_output':
      case 'image_generation_output':
      case 'imageGenerationCallOutput':
      case 'imageGenerationOutput': {
        const image = generatedImageOf(payload)
        pushToolResult(payload.call_id ?? payload.id ?? payload.item_id,
          image === undefined ? outputText(payload) : '[image generated]', outputIsError(payload), image?.key)
        break
      }
      case 'imageGeneration':
      case 'image_generation': {
        const image = generatedImageOf(payload)
        const callId = payload.call_id ?? payload.callId ?? payload.id
        pushToolCall(callId, 'image_generation', payload.action ?? { prompt: payload.revisedPrompt ?? payload.prompt ?? '' }, {
          generated: true,
          imageKey: image?.key,
        })
        pushToolResult(callId, image === undefined ? outputText(payload) : '[image generated]', itemFailed(payload), image?.key)
        break
      }
      case 'agent_message': {
        // Inter-agent envelopes are normally encrypted. If a readable text is
        // present, retain it as an assistant message instead of losing it.
        const text = textOf(payload.content) || (typeof payload.text === 'string' ? payload.text : '')
        if (text.length > 0) emitMessage(appMessagePayload({ ...payload, text }, 'assistant'), false)
        break
      }
      default:
        break
    }
  }
  if (turnOpen) endTurn('completed')
  // DSH's title projection is event-backed. Pinning a fallback title avoids an
  // extra model call while preserving the exact human message provenance that
  // the title invariant requires.
  const finalTitle = explicitTitle.length > 0 ? explicitTitle : titleText
  if (finalTitle.length > 0) {
    push('session/title', {
      title: finalTitle,
      messageSeqs: explicitTitle.length > 0 || titleSeq === undefined ? [] : [titleSeq],
      source: { kind: explicitTitle.length > 0 ? 'user' : 'fallback' },
    })
  }

  return { records, cwd, id, createdAt, provider, model, turnCount: turn, stats }
}

/**
 * Canonical plaintext body of a built session: every event line, no header.
 *
 * This is the unit of comparison for "has this conversation changed?". It is
 * taken before compression on purpose, so the answer does not depend on the
 * encoder producing identical bytes across versions.
 */
export function sessionBody(built) {
  const [, ...eventRecords] = built.records
  return `${eventRecords.map((r) => JSON.stringify(r)).join('\n')}\n`
}

/** Stable digest of the body — the value the importer compares against disk. */
export function bodySha256(built) {
  return createHash('sha256').update(sessionBody(built)).digest('hex')
}

/**
 * Serialize one built session into the physical log the jsonl backend reads:
 * frame 1 is exactly the header line, frame 2+ carries the event stream.
 * Decoding the first frame must yield one newline-terminated line.
 */
export function serializeSession(built, body = sessionBody(built)) {
  const [headerRecord] = built.records
  const headerFrame = `${JSON.stringify(headerRecord)}\n`
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerFrame, 'utf8'), ZSTD_OPTIONS),
    zstdCompressSync(Buffer.from(body, 'utf8'), ZSTD_OPTIONS),
  ])
}

/** Absolute directory one built session occupies under a sessions root. */
export function sessionDirFor(built, root) {
  return join(root, projectKey(built.cwd), encodeSegment(built.id))
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
  dryRun = false, codexRoot, saveImages, includeArchived = false, limit, project, signal,
}) {
  const checkAborted = () => {
    if (signal?.aborted !== true) return
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
    const error = new Error('import aborted')
    error.name = 'AbortError'
    throw error
  }
  checkAborted()
  const requested = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
  const requestedIds = requested.map(stringId).filter((id) => id !== undefined)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error('limit must be a positive integer when provided')
  }
  const rollouts = findRollouts(requestedIds.length > 0 ? Number.MAX_SAFE_INTEGER : sinceHours, codexRoot, { includeArchived })
  let references = collectConversationRefs(rollouts, requestedIds)
    .filter((reference) => projectMatches(reference.cwd, project))
  // Discovery is chronological for deterministic conversion. A user-facing
  // limit follows the competitors' convention and keeps the newest N after
  // project/id filtering, while restoring chronological order for the builder.
  if (limit !== undefined && references.length > limit) references = references.slice(-limit)
  // A dry run must not mutate the attachment store. The old implementation
  // admitted images before checking `dryRun`, which made a supposedly
  // read-only command create objects under $DSH_HOME/attachments.
  const imageRefs = new Map()
  const imageRefusalMap = new Map()

  const results = []
  for (const convo of iterateConversations(references)) {
    checkAborted()
    await admitImages([convo], dryRun ? undefined : saveImages, imageRefs, imageRefusalMap)
    checkAborted()
    const built = buildRecords(convo.segments, convo.sessionId, { maxToolOutput, imageRefs })
    const dir = sessionDirFor(built, root ?? '/dev/null')
    const body = sessionBody(built)
    if (!dryRun) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'session.v3.jsonl.zstd'), serializeSession(built, body), { mode: 0o600 })
    }
    results.push({
      id: built.id,
      cwd: built.cwd,
      dir,
      segments: convo.segments.length,
      records: built.records.length,
      turns: built.turnCount,
      // Digest of what this run produced. The sync step compares it against the
      // installed log: equal means there is nothing to write.
      bodySha256: createHash('sha256').update(body).digest('hex'),
      stats: built.stats,
    })
  }
  return {
    rollouts: rollouts.length,
    results,
    imagesAvailable: imageRefs.size,
    imageRefusals: [...imageRefusalMap.values()],
  }
}
