/**
 * Pure normalizers for the loosely shaped payloads Codex writes to rollouts.
 * Keeping these at the boundary lets the session state machine deal in plain
 * text, call ids, and failure flags instead of carrying API-version branches.
 *
 * @module dsh-codex-import/codex-payload
 */

/** Extract readable text from a Codex content array or string. */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (typeof item === 'string') return item
      if (item === null || typeof item !== 'object') return ''
      if (typeof item.text === 'string') return item.text
      if (typeof item.content === 'string') return item.content
      if (Array.isArray(item.content)) return textOf(item.content)
      if (typeof item.output_text === 'string') return item.output_text
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

function parseStructured(value) {
  if (typeof value !== 'string' || !/^[\[{]/.test(value.trim())) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Normalize status spellings shared by response items and telemetry events. */
export function normalizeStatus(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Convert the JavaScript object literal emitted by newer custom tools into a
 * JSON argument string without evaluating untrusted rollout content. Codex
 * has used forms such as `tools.exec_command({cmd:"ls", opts:{cwd:"/tmp"}})`;
 * older versions already emitted JSON and are returned byte-for-byte.
 *
 * @returns `{ arguments: string, fallback: boolean }`.
 */
export function customToolArguments(raw) {
  if (typeof raw !== 'string') return { arguments: JSON.stringify(raw ?? {}), fallback: false }
  const text = raw.trim()
  if (text.length === 0) return { arguments: JSON.stringify(raw), fallback: false }
  try {
    JSON.parse(text)
    return { arguments: raw, fallback: false }
  } catch {
    // Continue with the deliberately small, side-effect-free literal parser.
  }
  if (!/^\{|^\(|(?:^|\s)(?:return\s+|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(text)) {
    return { arguments: JSON.stringify(raw), fallback: false }
  }
  const start = findObjectStart(text)
  if (start < 0) return { arguments: JSON.stringify(raw), fallback: true }
  const end = findMatchingBrace(text, start)
  if (end < 0) return { arguments: JSON.stringify(raw), fallback: true }
  try {
    const value = parseJsLiteral(text.slice(start, end + 1))
    return { arguments: JSON.stringify(value), fallback: false }
  } catch {
    return { arguments: JSON.stringify(raw), fallback: true }
  }
}

function skipQuoted(text, start) {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue }
    if (text[i] === quote) return i + 1
  }
  return text.length
}

function skipTemplate(text, start) {
  // Template values are intentionally unsupported by parseJsLiteral, but we
  // still skip them while looking for the first object brace.
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue }
    if (text[i] === '`') return i + 1
  }
  return text.length
}

function findObjectStart(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i) - 1; continue }
    if (ch === '`') { i = skipTemplate(text, i) - 1; continue }
    if (ch === '{') return i
  }
  return -1
}

function findMatchingBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i) - 1; continue }
    if (ch === '`') { i = skipTemplate(text, i) - 1; continue }
    if (ch === '{') depth += 1
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/** Minimal recursive-descent parser for JSON-like JavaScript literals. */
function parseJsLiteral(source) {
  let index = 0
  const fail = () => { throw new SyntaxError('unsupported custom tool argument literal') }
  const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
  const ws = () => { while (/\s/.test(source[index] ?? '')) index += 1 }
  const string = () => {
    const quote = source[index++]
    let out = ''
    while (index < source.length) {
      const ch = source[index++]
      if (ch === quote) return out
      if (ch !== '\\') { out += ch; continue }
      const escaped = source[index++]
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
      if (simple[escaped] !== undefined) { out += simple[escaped]; continue }
      if (escaped === 'u') {
        const hex = source.slice(index, index + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
        out += String.fromCharCode(Number.parseInt(hex, 16)); index += 4; continue
      }
      if (escaped === 'x') {
        const hex = source.slice(index, index + 2)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail()
        out += String.fromCharCode(Number.parseInt(hex, 16)); index += 2; continue
      }
      out += escaped
    }
    fail()
  }
  const identifier = () => {
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))
    if (!match) fail()
    index += match[0].length
    return match[0]
  }
  const number = () => {
    const match = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (!match || !Number.isFinite(Number(match[0]))) fail()
    index += match[0].length
    return Number(match[0])
  }
  const value = () => {
    ws()
    const ch = source[index]
    if (ch === '{') return object()
    if (ch === '[') return array()
    if (ch === '"' || ch === "'") return string()
    if (ch === '-' || ch === '.' || /\d/.test(ch ?? '')) return number()
    if (source.startsWith('true', index)) { index += 4; return true }
    if (source.startsWith('false', index)) { index += 5; return false }
    if (source.startsWith('null', index)) { index += 4; return null }
    fail()
  }
  const array = () => {
    index += 1; const out = []; ws()
    if (source[index] === ']') { index += 1; return out }
    while (true) {
      out.push(value()); ws()
      if (source[index] === ']') { index += 1; return out }
      if (source[index++] !== ',') fail()
      ws()
      if (source[index] === ']') { index += 1; return out }
    }
  }
  const object = () => {
    index += 1; const out = Object.create(null); ws()
    if (source[index] === '}') { index += 1; return out }
    while (true) {
      ws()
      const key = source[index] === '"' || source[index] === "'" ? string() : identifier()
      if (unsafeKeys.has(key)) fail()
      ws()
      if (source[index++] !== ':') fail()
      Object.defineProperty(out, key, {
        value: value(), enumerable: true, writable: true, configurable: true,
      }); ws()
      if (source[index] === '}') { index += 1; return out }
      if (source[index++] !== ',') fail()
      ws()
      if (source[index] === '}') { index += 1; return out }
    }
  }
  const parsed = value(); ws()
  if (index !== source.length) fail()
  return parsed
}

/** Extract readable text from string, array, or structured tool output. */
export function outputText(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const layers = [source, source.item, source.event, source.data]
    .filter((layer) => layer && typeof layer === 'object')
  const keys = ['output', 'formatted_output', 'aggregated_output', 'aggregatedOutput', 'stdout', 'stderr', 'result', 'content', 'content_items', 'contentItems', 'body', 'text']
  let output
  let found = false
  for (const layer of layers) {
    for (const key of keys) {
      if (layer[key] === undefined || layer[key] === null) continue
      found = true
      const candidate = parseStructured(layer[key])
      if (output === undefined || (typeof candidate === 'string' && candidate.length > 0)) output = candidate
    }
  }
  if (!found) output = undefined
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return textOf(output)
  if (output === undefined || output === null) return ''
  if (typeof output !== 'object') return String(output)
  if (typeof output.content === 'string') return output.content
  if (Array.isArray(output.content)) return textOf(output.content)
  if (typeof output.body === 'string') return output.body
  if (Array.isArray(output.content_items)) return textOf(output.content_items)
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}

/** A structured function/tool output can carry its own success flag. */
export function outputIsError(payload) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const visit = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const status = normalizeStatus(value.status)
    const exitCode = value.exit_code ?? value.exitCode
    if (FAILED_STATUSES.has(status)
      || value.success === false
      || value.error !== undefined && value.error !== null
      || (exitCode !== undefined && Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0)) return true
    for (const nested of [value.output, value.result, value.item, value.event, value.data, value.metadata]) {
      const parsed = typeof nested === 'string' ? parseStructured(nested) : nested
      if (visit(parsed, seen)) return true
    }
    return false
  }
  return visit(source)
}

/** Plaintext reasoning summaries (the encrypted reasoning body is unreadable). */
export function reasoningSummary(payload) {
  const summary = payload?.summary ?? payload?.summary_text ?? payload?.summaryText
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item.text === 'string') return item.text
      if (item && typeof item.summary_text === 'string') return item.summary_text
      return ''
    })
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Render a tool-search result as readable text. */
export function toolSearchText(payload) {
  if (!Array.isArray(payload?.tools)) return ''
  return payload.tools
    .map((tool) => {
      const name = tool?.name ?? tool?.type ?? 'tool'
      const description = typeof tool?.description === 'string' ? ` — ${tool.description}` : ''
      return `- ${name}${description}`
    })
    .join('\n')
}

const FAILED_STATUSES = new Set([
  'failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'incomplete',
  'timeout', 'timed_out', 'aborted', 'interrupted', 'rejected', 'declined',
  'denied', 'refused', 'expired', 'killed', 'terminated',
])

function valueText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textOf(value)
  if (value === undefined || value === null) return ''
  if (typeof value !== 'object') return String(value)
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return textOf(value.content)
  if (typeof value.body === 'string') return value.body
  if (Array.isArray(value.content_items)) return textOf(value.content_items)
  if (Array.isArray(value.contentItems)) return textOf(value.contentItems)
  if (typeof value.text === 'string') return value.text
  if (typeof value.message === 'string') return value.message
  if (value.output !== undefined) return valueText(value.output)
  if (value.result !== undefined) return valueText(value.result)
  if (value.data !== undefined) return valueText(value.data)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function eventFailure(payload, item) {
  const visit = (value, seen = new Set()) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    const status = normalizeStatus(value.status)
    const exitCode = value.exit_code ?? value.exitCode
    if (FAILED_STATUSES.has(status)
      || value.success === false
      || value.error !== undefined && value.error !== null
      || value.result?.Err !== undefined
      || value.result?.error !== undefined
      || (exitCode !== undefined && Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0)) return true
    return [value.result, value.item, value.event, value.data, value.metadata].some((nested) => visit(nested, seen))
  }
  return visit(payload) || visit(item)
}

function eventText(payload, item) {
  let seen = false
  let text = ''
  const layers = [payload, item, payload?.event, payload?.data]
    .filter((layer) => layer && typeof layer === 'object')
  for (const layer of layers) {
    for (const key of ['output', 'formatted_output', 'aggregated_output', 'aggregatedOutput', 'stdout', 'stderr', 'result', 'error', 'content', 'content_items', 'contentItems', 'body', 'text']) {
      const value = layer[key]
      if (value === undefined || value === null) continue
      seen = true
      const candidate = valueText(value)
      // Prefer a non-empty stderr/aggregated result over an earlier empty
      // field, while retaining the fact that an explicit empty output existed.
      if (candidate.length > 0) text = candidate
    }
  }
  return { text, hasOutput: seen }
}

/** Normalize a call id the same way the converter normalizes response items. */
function normalizedCallId(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Merge one event's output into an existing outcome. */
function mergeOutcome(previous, currentText, isDelta, failed) {
  let text = previous?.text ?? ''
  if (currentText.text.length > 0) {
    text = isDelta && text.length > 0 ? `${text}${currentText.text}` : currentText.text
  }
  return {
    text,
    hasOutput: Boolean(previous?.hasOutput || currentText.hasOutput),
    isError: Boolean(previous?.isError || failed),
  }
}

/**
 * Collect completion outcomes keyed by call id. Codex has emitted several event
 * names over time (`exec_command_end`, MCP end events, and item-completion
 * wrappers), but their output and failure signals are consistent.
 *
 * The queue is a second, conservative view used only when a malformed rollout
 * reuses one raw call id for multiple calls. The historical Map return remains
 * the aggregate view, so callers that only have one call keep the old behavior.
 */
export function collectToolOutcomeData(records) {
  const outcomes = new Map()
  const queues = new Map()
  const active = new Map()
  let recordIndex = 0
  for (const record of records ?? []) {
    const currentIndex = recordIndex++
    if (record?.type !== 'event_msg') continue
    const payload = record.payload ?? {}
    const item = payload.item && typeof payload.item === 'object' ? payload.item : undefined
    const nested = [payload.event, payload.data]
      .filter((value) => value && typeof value === 'object')
    const rawCallId = payload.call_id ?? payload.callId ?? payload.item_id
      ?? item?.call_id ?? item?.callId ?? item?.item_id
      ?? nested.flatMap((value) => [value.call_id, value.callId, value.item_id]).find((value) => value !== undefined)
      ?? (item?.id !== undefined ? item.id : undefined)
    const callId = normalizedCallId(rawCallId)
    if (callId === undefined) continue
    const type = String(payload.type ?? item?.type ?? nested.map((value) => value.type).find(Boolean) ?? '').toLowerCase()
    const layers = [payload, item, ...nested]
    const hasOutput = ['output', 'formatted_output', 'aggregated_output', 'aggregatedOutput', 'stdout', 'stderr', 'result', 'error', 'content', 'content_items', 'contentItems', 'body', 'text']
      .some((key) => layers.some((layer) => layer?.[key] !== undefined))
    const isCompletion = /(?:^|[_.-])(?:end|complete|completed|output|result|failed|failure|error)$/.test(type)
      || (item?.id !== undefined && /(?:command|tool|execution|change|search)/i.test(String(item?.type ?? '')))
    const failed = eventFailure(payload, item)
    if (!isCompletion && !hasOutput && !failed) continue
    const currentText = eventText(payload, item)
    const isDelta = /(?:delta|chunk)/.test(type)
    const aggregate = mergeOutcome(outcomes.get(callId), currentText, isDelta, failed)
    outcomes.set(callId, aggregate)

    // Keep deltas in one group and start a new group after a completed event.
    // Identical adjacent completion wrappers are usually mirrors of one event;
    // merge those back together so they do not look like a second call.
    const ordinal = Number.isFinite(record?.ordinal) ? record.ordinal : currentIndex
    let group = active.get(callId)
    const sameMirror = group?.closed === true && !isDelta
      && group.text === currentText.text && group.isError === failed
      // Same-type completions are kept as separate groups: malformed exports
      // can reuse a raw id for two calls with identical (including empty)
      // output. A different wrapper type is the safer mirror signal.
      && group.lastType !== type
      && Math.abs(ordinal - group.lastOrdinal) <= 1
    if (group === undefined || (group.closed === true && !sameMirror)) {
      group = { text: '', hasOutput: false, isError: false, closed: false,
        lastOrdinal: ordinal, lastType: type }
      const list = queues.get(callId)
      if (list === undefined) queues.set(callId, [group])
      else list.push(group)
      active.set(callId, group)
    }
    const merged = mergeOutcome(group, currentText, isDelta, failed)
    group.text = merged.text
    group.hasOutput = merged.hasOutput
    group.isError = merged.isError
    group.lastOrdinal = ordinal
    group.lastType = type
    if (isCompletion && !isDelta) group.closed = true
  }
  return { outcomes, queues }
}

/** Aggregate completion outcomes keyed by raw call id. */
export function collectToolOutcomes(records) {
  return collectToolOutcomeData(records).outcomes
}

/** Ordered completion groups for malformed rollouts that reuse call ids. */
export function collectToolOutcomeQueues(records) {
  return collectToolOutcomeData(records).queues
}
