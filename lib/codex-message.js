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
import { textOf } from './codex-payload.js'

const USER_EVENT_TYPES = new Set(['usermessage', 'userprompt', 'userinput'])
const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded'])

/** Normalize App Server camelCase content blocks to rollout-style aliases. */
export function normalizeMessageContent(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type === 'text' || block.type === 'inputText' || block.type === 'outputText') {
      return {
        ...block,
        type: block.type === 'outputText' ? 'output_text' : 'input_text',
        text: block.text ?? '',
      }
    }
    if (block.type === 'image' && typeof block.url === 'string') {
      return { ...block, type: 'input_image', image_url: block.url }
    }
    if (block.type === 'inputImage' && typeof block.imageUrl === 'string') {
      return { ...block, type: 'input_image', image_url: block.imageUrl }
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
    content: normalizeMessageContent(payload.content ?? (payload.text === undefined ? [] : [{ type: 'text', text: payload.text }])),
  }
}

/**
 * Normalize the telemetry-side user prompt Codex emits in `event_msg`.
 *
 * Most rollouts also contain the same prompt as a `response_item`; callers
 * should use the returned text as a dedupe key and only materialize this
 * payload when the normal item is absent. Keeping the shape conversion here
 * makes the fallback work for both snake_case JSONL and App Server aliases.
 */
export function eventUserPayload(payload) {
  const source = payload?.event && typeof payload.event === 'object'
    ? payload.event
    : payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const type = String(source?.type ?? '').replace(/[_-]/g, '').toLowerCase()
  if (!USER_EVENT_TYPES.has(type)) return undefined
  const raw = source?.message ?? source?.text ?? source?.content ?? source?.user_message
  let id
  let content
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    id = raw.id ?? raw.message_id ?? raw.messageId
    content = Array.isArray(raw.content)
      ? raw.content
      : typeof raw.content === 'string'
        ? [{ type: 'text', text: raw.content }]
        : raw.text === undefined ? [] : [{ type: 'text', text: raw.text }]
  } else if (Array.isArray(raw)) {
    content = raw
  } else if (typeof raw === 'string' && raw.length > 0) {
    content = [{ type: 'input_text', text: raw }]
  } else {
    content = []
  }
  const normalized = normalizeMessageContent(content)
  return {
    payload: {
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      type: 'message',
      role: 'user',
      content: normalized,
    },
    text: textOf(normalized),
  }
}

/** Whether an App Server tool item represents a failed/declined result. */
export function itemFailed(payload) {
  const status = String(payload?.status ?? '').toLowerCase()
  return status.length > 0 && !SUCCESS_STATUSES.has(status)
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
const AGENT_HISTORY = /^\s*The following is the Codex agent history added since your last\b/i
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
