/**
 * Price a converted session the way the harness prices it.
 *
 * A session can only be continued while its derived history fits the model's
 * context window, and compaction cannot rescue one that does not: condensing a
 * span requires replaying that span to the summarizer, so a history larger than
 * the window cannot even be summarised. The importer therefore has to know, at
 * conversion time, roughly how many tokens it is about to install.
 *
 * The numbers here mirror `@deepseek-ai/dsh-token-meter`: a fixed
 * four-characters-per-token density with per-block structural overhead. They are
 * deliberately the harness's own estimates rather than a tokenizer's, because
 * the harness is what decides whether a request fits — and because an estimate
 * that disagrees with it would give a misleading budget report.
 *
 * @module dsh-codex-import/session-tokens
 */

/** Fixed text-density estimate; mirrors the harness token meter. */
export const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4

/** Per-message framing overhead added to non-system roles (four chat tokens). */
export const MESSAGE_OVERHEAD = 4

const textLength = (value) => (typeof value === 'string' ? value.length : 0)

/** Price structured JSON outside the typed arms, exactly as the harness does. */
function estimateStructuralBlock(block) {
  let serialized
  try {
    serialized = JSON.stringify(block)
  } catch {
    return BLOCK_OVERHEAD
  }
  return BLOCK_OVERHEAD + Math.ceil((serialized?.length ?? 0) / CHARS_PER_TOKEN)
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 *
 * @param blocks - content blocks of one derived message.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks) {
  if (!Array.isArray(blocks)) return 0
  let tokens = 0
  for (const block of blocks) {
    switch (block?.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(textLength(block.text) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(textLength(block.name) / CHARS_PER_TOKEN)
          + Math.ceil(textLength(block.arguments) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price one derived message.
 *
 * A `system/message` is serialized by adapters as a plain string, so it is
 * priced as text density without per-block overhead.
 *
 * @param message - a value returned by the session's per-node projection.
 * @returns heuristic tokens for the message.
 */
export function estimateMessage(message) {
  if (message === null || message === undefined) return 0
  const content = message.content
  if (message.role === 'system') {
    if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN)
    if (Array.isArray(content)) return estimateContent(content)
    return 0
  }
  return estimateContent(content) + MESSAGE_OVERHEAD
}

/**
 * Project one converted event to the message the model would receive.
 *
 * This is the importer's local copy of the harness's per-node projection. An
 * assistant message with no content blocks produces no message at all, which is
 * also how the harness prices it (zero) — the event is bookkeeping only.
 *
 * @param event - one converted DSH session event.
 * @returns the derived message, or null when the event produces none.
 */
export function deriveEventMessage(event) {
  switch (event?.type) {
    case 'system/message':
    case 'user/message':
      return event.data ?? null
    case 'assistant/message':
    case 'tool/result': {
      const message = event.data?.message
      if (message === undefined || message === null) return null
      if (event.type === 'assistant/message' && !Array.isArray(message.content)) return null
      if (event.type === 'assistant/message' && message.content.length === 0) return null
      return message
    }
    default:
      return null
  }
}

/**
 * Fold converted events into the surface a resuming model would be sent.
 *
 * Appends extend the surface; a `replace` surfaceOp shadows the events it names
 * and stands in their place, which is how a compaction checkpoint hides history
 * without deleting it. A converted import is normally all appends, but a log
 * that was compacted inside DSH and then refreshed is not — measuring one must
 * not charge for history the model no longer sees.
 *
 * @param events - converted session events, in log order.
 * @returns the derived surface in model-visible order.
 */
export function foldSurface(events) {
  const nodes = []
  for (const event of events ?? []) {
    const op = event?.surfaceOp
    if (op !== undefined && op !== null && typeof op === 'object' && op.op === 'replace') {
      const startIdx = nodes.findIndex((node) => node.seq === op.startSeq)
      const endIdx = nodes.findIndex((node) => node.seq === op.endSeq)
      // An unresolvable range is log corruption; the harness refuses it too.
      // Skipping keeps the price conservative rather than silently free.
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
      nodes.splice(startIdx, endIdx - startIdx + 1, event)
      continue
    }
    if (deriveEventMessage(event) !== null) nodes.push(event)
  }
  return nodes
}

/**
 * Price the model-visible surface of a converted session.
 *
 * @param events - converted session events, in log order.
 * @returns the surface node count and the harness-equivalent token estimate.
 */
export function estimateSessionTokens(events) {
  const nodes = foldSurface(events)
  let tokens = 0
  for (const node of nodes) tokens += estimateMessage(deriveEventMessage(node))
  return { nodes: nodes.length, tokens }
}

/** Marker left in place of removed text, so the loss is never silent. */
export const CLAMP_MARKER = '\n\n[... middle trimmed during Codex import ...]\n\n'

/**
 * Bound one text by keeping its head and its tail.
 *
 * A single oversized unit is the one thing compaction cannot repair: balanced
 * summary compaction refuses to split it, and the pruner only trims tool
 * results. When one pasted document dominates a session, trimming it at import
 * time is what keeps the session resumable at all. The head and the tail carry
 * the instruction and the conclusion, which is where a reference document's
 * meaning usually sits.
 *
 * @param text - candidate text.
 * @param limit - maximum characters to keep, or 0 for no limit.
 * @returns the text, shortened symmetrically when it exceeds the limit.
 */
export function clampText(text, limit) {
  if (typeof text !== 'string' || limit <= 0 || text.length <= limit) return text
  const tailChars = Math.min(Math.floor(limit / 4), limit)
  const headChars = limit - tailChars
  const removed = text.length - limit
  return `${text.slice(0, headChars)}${CLAMP_MARKER}[... ${removed} of ${text.length} chars trimmed during Codex import ...]\n\n${text.slice(text.length - tailChars)}`
}

/**
 * Apply the text budget to every model-visible text a conversion produced.
 *
 * The clamp is applied once, over the finished event list, so the converter's
 * emission points stay unaware of it and a refresh of the same conversation
 * clamps identically. Only blocks the token meter prices as text are touched:
 * text and reasoning blocks on a message, and a tool call's JSON arguments.
 *
 * @param events - converted session events; modified in place.
 * @param limit - per-text character budget, or 0 for no limit.
 * @returns how many texts were shortened.
 */
export function clampSessionText(events, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0
  let clamped = 0
  const clampBlock = (block) => {
    if (block?.type === 'text' || block?.type === 'reasoning') {
      const next = clampText(block.text, limit)
      if (next !== block.text) {
        block.text = next
        clamped += 1
      }
      return
    }
    if (block?.type === 'tool-call') {
      const next = clampText(block.arguments, limit)
      if (next !== block.arguments) {
        block.arguments = next
        clamped += 1
      }
    }
  }
  for (const event of events ?? []) {
    if (event?.type === 'system/message') {
      // Adapters serialize the system prompt as a plain string.
      if (typeof event.data === 'string') continue
      const next = clampText(event.data?.text, limit)
      if (next !== event.data?.text) {
        event.data.text = next
        clamped += 1
      }
      continue
    }
    const content = event?.type === 'user/message' ? event.data?.content : event?.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) clampBlock(block)
  }
  return clamped
}

