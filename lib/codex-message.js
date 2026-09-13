/**
 * Message and title normalisation for Codex rollout records.
 *
 * Codex has two record producers in the wild: the JSONL rollout writer uses
 * snake_case names, while the App Server uses camelCase items and content
 * blocks.  Keeping those translations here leaves the record state machine in
 * `convert.js` concerned only with DSH events.
 *
 * @module dsh-codex-import/codex-message
 */
import { textOf, normalizeStatus } from './codex-payload.js'

const USER_EVENT_TYPES = new Set(['usermessage', 'userprompt', 'userinput'])
const ASSISTANT_EVENT_TYPES = new Set(['agentmessage', 'assistantmessage'])
const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded'])
const NON_FAILURE_STATUSES = new Set([
  ...SUCCESS_STATUSES,
  'in_progress', 'inprogress', 'running', 'queued', 'pending', 'started', 'streaming',
])

// The rollout writer uses snake_case while the App Server uses camelCase. A
// few telemetry producers also capitalise item names. Normalize all known
// spellings once so conversion and inventory cannot disagree about a record.
const ITEM_TYPE_ALIASES = new Map([
  ['message', 'message'],
  ['usermessage', 'userMessage'],
  ['userprompt', 'userMessage'],
  ['userinput', 'userMessage'],
  ['agentmessage', 'agentMessage'],
  ['assistantmessage', 'agentMessage'],
  ['plan', 'plan'],
  ['reasoning', 'reasoning'],
  ['functioncall', 'function_call'],
  ['functioncalloutput', 'function_call_output'],
  ['toolcall', 'function_call'],
  ['toolresult', 'function_call_output'],
  ['customtoolcall', 'custom_tool_call'],
  ['customtoolcalloutput', 'custom_tool_call_output'],
  ['commandexecution', 'commandExecution'],
  ['filechange', 'fileChange'],
  ['mcptoolcall', 'mcpToolCall'],
  ['dynamictoolcall', 'dynamicToolCall'],
  ['websearch', 'webSearch'],
  ['localshellcall', 'local_shell_call'],
  ['shellcall', 'shell_call'],
  ['localshellcalloutput', 'local_shell_call_output'],
  ['shellcalloutput', 'shell_call_output'],
  ['toolsearchcall', 'tool_search_call'],
  ['toolsearchoutput', 'tool_search_output'],
  ['websearchcall', 'web_search_call'],
  ['imagegenerationcall', 'image_generation_call'],
  ['imagegenerationcalloutput', 'image_generation_call_output'],
  ['imagegenerationoutput', 'image_generation_output'],
  ['imagegeneration', 'imageGeneration'],
])

/** Return the canonical response-item spelling for any known alias. */
export function normalizeItemType(value) {
  const raw = String(value ?? '')
  // `agent_message` is the legacy inter-agent envelope and intentionally has
  // different semantics from App Server's `agentMessage` assistant item.
  if (/^agent[_-]message$/i.test(raw)) return 'agent_message'
  const normalized = raw.replace(/[\s_-]/g, '').toLowerCase()
  return ITEM_TYPE_ALIASES.get(normalized) ?? raw
}

/** Resolve a message role from an explicit role or an App Server item type. */
export function messageRole(payload) {
  if (typeof payload?.role === 'string' && payload.role.trim().length > 0) {
    return payload.role.trim().toLowerCase()
  }
  switch (normalizeItemType(payload?.type)) {
    case 'userMessage': return 'user'
    case 'agentMessage':
    case 'plan': return 'assistant'
    default: return undefined
  }
}

/** Normalize a message's string/object shorthand into a content array. */
export function messageContentOf(payload, depth = 0, seen = new Set()) {
  if (payload === null || typeof payload !== 'object' || depth > 6 || seen.has(payload)) return []
  seen.add(payload)
  const direct = payload.content ?? payload.contentItems ?? payload.content_items ?? payload.parts
  if (Array.isArray(direct)) return direct
  if (typeof direct === 'string') return [{ type: 'text', text: direct }]
  if (direct !== null && typeof direct === 'object') {
    // A typed object is already a content block; an untyped object is usually
    // another message wrapper (for example `{content: {parts: [...]}}`).
    if (typeof direct.type === 'string') return [direct]
    return messageContentOf(direct, depth + 1, seen)
  }
  if (typeof payload.text === 'string') return [{ type: 'text', text: payload.text }]
  if (payload.message !== undefined && payload.message !== payload) {
    if (typeof payload.message === 'string') return [{ type: 'text', text: payload.message }]
    if (payload.message !== null && typeof payload.message === 'object') {
      return messageContentOf(payload.message, depth + 1, seen)
    }
  }
  return []
}

/** Extract a turn id from response items, telemetry wrappers, or passthrough metadata. */
export function turnIdOf(payload) {
  const queue = [{ value: payload, depth: 0 }]
  const seen = new Set()
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const candidate = queue[cursor].value
    if (candidate === null || typeof candidate !== 'object') continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const value = candidate.turn_id ?? candidate.turnId ?? candidate.turnID
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (queue[cursor].depth >= 6) continue
    for (const key of [
      'internal_chat_message_metadata_passthrough', 'metadata', 'event', 'data',
      'item', 'message', 'payload', 'context',
    ]) {
      const nested = candidate[key]
      if (nested !== null && typeof nested === 'object') {
        queue.push({ value: nested, depth: queue[cursor].depth + 1 })
      }
    }
  }
  return undefined
}

/** Normalize App Server camelCase content blocks to rollout-style aliases. */
export function normalizeMessageContent(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    const blockType = String(block.type ?? '').replace(/[\s_-]/g, '').toLowerCase()
    if (blockType === 'text' || blockType === 'inputtext' || blockType === 'outputtext') {
      return {
        ...block,
        type: blockType === 'outputtext' ? 'output_text' : 'input_text',
        text: block.text ?? '',
      }
    }
    if (blockType === 'image' || blockType === 'imageurl') {
      const rawUrl = block.url ?? block.image_url ?? block.imageUrl
      const imageUrl = rawUrl !== null && typeof rawUrl === 'object'
        ? rawUrl.url ?? rawUrl.href : rawUrl
      if (typeof imageUrl === 'string') return { ...block, type: 'input_image', image_url: imageUrl }
    }
    if (blockType === 'inputimage') {
      const rawUrl = block.imageUrl ?? block.image_url ?? block.url
      const imageUrl = rawUrl !== null && typeof rawUrl === 'object'
        ? rawUrl.url ?? rawUrl.href : rawUrl
      if (typeof imageUrl === 'string') return { ...block, type: 'input_image', image_url: imageUrl }
    }
    return block
  })
}

/** Extract tool-use blocks embedded in an assistant message. */
export function inlineToolBlocks(content) {
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = String(block.type ?? '').toLowerCase().replace(/[_-]/g, '')
    if (type !== 'tooluse' && type !== 'toolcall' && type !== 'functioncall') continue
    const rawId = block.id ?? block.call_id ?? block.callId
    const name = block.name ?? block.tool ?? block.function?.name ?? 'tool'
    const args = block.input ?? block.arguments ?? block.args ?? block.function?.arguments ?? {}
    blocks.push({ id: rawId, name, args })
  }
  return blocks
}

/** Convert a stable App Server item into the legacy message envelope. */
export function appMessagePayload(payload, role) {
  return {
    ...payload,
    type: 'message',
    role,
    content: normalizeMessageContent(messageContentOf(payload)),
  }
}

/**
 * Normalize a telemetry-side message Codex emits in `event_msg`.
 *
 * Most rollouts also contain the same prompt as a `response_item`; callers
 * should use the returned content as a dedupe key and only materialize this
 * payload when the normal item is absent. Keeping the shape conversion here
 * makes the fallback work for both snake_case JSONL and App Server aliases,
 * including `item_completed` records whose `UserMessage` is nested in `item`.
 */
function eventMessagePayload(payload, expectedRole, acceptedTypes) {
  const layers = []
  const seen = new Set()
  const queue = [{ value: payload, depth: 0 }]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { value, depth } = queue[cursor]
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    layers.push(value)
    if (depth >= 6) continue
    for (const key of [
      'event', 'data', 'item', 'payload', 'message', 'user_message', 'output', 'result',
    ]) {
      const nested = value[key]
      if (nested !== null && typeof nested === 'object') queue.push({ value: nested, depth: depth + 1 })
    }
  }
  const source = layers.find((candidate) => {
    if (expectedRole === 'assistant' && /^agent[_-]message$/i.test(String(candidate.type ?? ''))) {
      return false
    }
    const rawType = String(candidate.type ?? '').replace(/[\s_-]/g, '').toLowerCase()
    if (acceptedTypes.has(rawType)) return true
    return rawType === 'message' && String(candidate.role ?? '').toLowerCase() === expectedRole
  })
  if (source === undefined) return undefined
  let id = source.id ?? source.message_id ?? source.messageId
  const content = []
  const append = (value) => {
    if (value === null || value === undefined) return
    if (typeof value === 'object' && !Array.isArray(value)) {
      id = value.id ?? value.message_id ?? value.messageId ?? id
    }
    const candidate = typeof value === 'object' && !Array.isArray(value)
      ? messageContentOf(value)
      : Array.isArray(value) ? value : [{ type: 'input_text', text: String(value) }]
    for (const block of candidate) {
      if (block === null || block === undefined) continue
      // Some telemetry versions expose the same text in both `message` and
      // `content`; retain distinct image blocks without duplicating the text.
      if (!content.some((existing) => {
        try { return JSON.stringify(existing) === JSON.stringify(block) } catch { return existing === block }
      })) content.push(block)
    }
  }
  append(source.message ?? source.user_message)
  append(source.text)
  append(source.output)
  append(source.content)
  const normalized = normalizeMessageContent(content)
  const uniqueContent = []
  const contentKeys = new Set()
  for (const block of normalized) {
    let key
    try { key = JSON.stringify(block) } catch { key = undefined }
    if (key !== undefined && contentKeys.has(key)) continue
    if (key !== undefined) contentKeys.add(key)
    uniqueContent.push(block)
  }
  const messageId = typeof id === 'string' && id.trim().length > 0 ? id.trim()
    : typeof id === 'number' && Number.isFinite(id) ? String(id) : undefined
  return {
    payload: {
      ...(messageId === undefined ? {} : { id: messageId }),
      type: 'message',
      role: expectedRole,
      content: uniqueContent,
    },
    text: textOf(uniqueContent),
    turnId: turnIdOf(source) ?? turnIdOf(payload),
  }
}

/** Recover a telemetry-side user prompt when its response item is absent. */
export function eventUserPayload(payload) {
  return eventMessagePayload(payload, 'user', USER_EVENT_TYPES)
}

/** Recover a telemetry-side assistant message when its response item is absent. */
export function eventAssistantPayload(payload) {
  return eventMessagePayload(payload, 'assistant', ASSISTANT_EVENT_TYPES)
}

/** Whether an App Server tool item represents a failed/declined result. */
export function itemFailed(payload) {
  const status = normalizeStatus(payload?.status)
  return status.length > 0 && !NON_FAILURE_STATUSES.has(status)
    || payload?.success === false
    || payload?.error !== undefined && payload?.error !== null
    || (payload?.exitCode !== undefined && payload?.exitCode !== null && Number(payload.exitCode) !== 0)
    || (payload?.exit_code !== undefined && payload?.exit_code !== null && Number(payload.exit_code) !== 0)
}

// Codex records its own machine context as role:user items. These prefixes
// identify injected scaffolding rather than a human prompt.
const INJECTED_TAG = /^\s*<(?:recommended_plugins|environment_context|permissions instructions|skill|turn_aborted|in-app-browser-context|app-context|user_instructions|agents_md|pending_input|codex_internal_context|user_shell_context|request_id|model|end_of_conversation|turn_id)(?:\s|>)/i
const AGENTS_MD_HEADING = /^\s*#\s*AGENTS\.md instructions\b/
const CONTEXT_ENVELOPE = /^\s*#\s*(?:Files mentioned by the user|Applications mentioned by the user|Context from my IDE setup):/i
// The suffix varies by the UI action that triggered the assessment (for
// example, "added since your last approval assessment" or "whose request
// action you are assessing"). The stable prefix is the machine envelope.
const AGENT_HISTORY = /^\s*The following is the Codex agent history\b/i
const MY_REQUEST = /##\s*My request(?:\s+for\s+Codex)?\s*:\s*/i

/**
 * Strip Codex's own context injection from a user message.
 * @returns the user's text, or undefined when the message is pure scaffolding.
 */
export function userText(text) {
  if (INJECTED_TAG.test(text) || AGENTS_MD_HEADING.test(text)) return undefined
  if (CONTEXT_ENVELOPE.test(text) || AGENT_HISTORY.test(text)) {
    const match = MY_REQUEST.exec(text)
    return match === null ? undefined : text.slice(match.index + match[0].length).trim()
  }
  return text
}

/** Build a deterministic, terminal-safe title from human text. */
export function fallbackTitle(text) {
  if (typeof text !== 'string') return ''
  const cleaned = text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= 80) return cleaned
  return `${cleaned.slice(0, 79).trimEnd()}…`
}
