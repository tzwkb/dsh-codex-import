/**
 * Prepare Codex rollout records for conversion.
 *
 * Rollouts can be cumulative across forked segments and can mirror user
 * messages through telemetry.  Keeping flattening, fallback recovery, and
 * cross-segment de-duplication outside the DSH state machine makes the latter
 * a straightforward record-to-event dispatcher.
 *
 * @module dsh-codex-import/codex-records
 */
import { textOf } from './codex-payload.js'
import { timestampOrder, stringId } from './codex-discovery.js'
import {
  normalizeItemType, normalizeMessageContent, messageContentOf, messageRole,
  turnIdOf, userText, eventUserPayload, eventAssistantPayload, inlineToolBlocks,
} from './codex-message.js'
import { generatedImageOf, imageIdentities, imageBlocksOf, imagesOf } from './codex-images.js'

/** Build a content identity that includes decoded image bytes but no text noise. */
function contentKey(content, role = 'user') {
  const normalized = normalizeMessageContent(content)
  const human = role === 'user' ? userText(textOf(normalized)) : textOf(normalized)
  const text = typeof human === 'string' ? human.trim() : ''
  const decodedImages = imagesOf(normalized)
  const imageKeys = decodedImages.map((image) => image.key)
  if (decodedImages.length < imageBlocksOf(normalized).length) imageKeys.push(...imageIdentities(normalized))
  if (text.length === 0 && imageKeys.length === 0) return undefined
  return JSON.stringify({ text, imageKeys })
}

function responseUserDescriptor(record) {
  const payload = record?.payload
  if (record?.type !== 'response_item' || messageRole(payload) !== 'user') return undefined
  const key = contentKey(messageContentOf(payload), 'user')
  if (key === undefined) return undefined
  return {
    key,
    id: stringId(payload?.id ?? payload?.message_id ?? payload?.messageId),
    turnId: turnIdOf(payload),
    segmentIndex: record.__segmentIndex,
    recordIndex: record.__recordIndex,
  }
}

function responseAssistantDescriptor(record) {
  const payload = record?.payload
  if (record?.type !== 'response_item' || messageRole(payload) !== 'assistant') return undefined
  const key = contentKey(messageContentOf(payload), 'assistant')
  if (key === undefined) return undefined
  return {
    key,
    id: stringId(payload?.id ?? payload?.message_id ?? payload?.messageId),
    turnId: turnIdOf(payload),
    segmentIndex: record.__segmentIndex,
    recordIndex: record.__recordIndex,
  }
}

/** Return a stable role/content fingerprint for message de-duplication. */
function messageFingerprint(payload) {
  const role = messageRole(payload)
  if (role === undefined) return undefined
  try {
    return `${role}:${JSON.stringify(normalizeMessageContent(messageContentOf(payload)))}`
  } catch {
    return undefined
  }
}

/**
 * Build an identity that is strong enough to fold cumulative copies without
 * treating two id-less, same-text turns as one.  A turn id wins; otherwise
 * the source timestamp/ordinal pair is the only positional identity we trust.
 */
function structuralMessageKey(record, fingerprint) {
  if (fingerprint === undefined) return undefined
  const payload = record?.payload
  const turnId = turnIdOf(payload)
  const timestamp = typeof record?.timestamp === 'string' ? record.timestamp : ''
  const ordinal = Number.isFinite(record?.ordinal) ? String(record.ordinal) : ''
  if (turnId !== undefined) return `turn:${fingerprint}:${turnId}:${timestamp}:${ordinal}`
  if (timestamp.length === 0 && ordinal.length === 0) return undefined
  return `position:${fingerprint}:${timestamp}:${ordinal}`
}

function telemetryMatchesNormal(normal, telemetry) {
  if (normal.key !== telemetry.key) return false
  // The response-item and telemetry producers allocate different message ids
  // for the same turn in current Codex builds. An equal id is strongest, but a
  // shared turn id must still be allowed to establish the mirror relationship.
  if (normal.id !== undefined && telemetry.id !== undefined && normal.id === telemetry.id) return true
  if (normal.turnId !== undefined && telemetry.turnId !== undefined) return normal.turnId === telemetry.turnId
  if (normal.id !== undefined || telemetry.id !== undefined) return false
  if (normal.turnId !== undefined || telemetry.turnId !== undefined) {
    return normal.turnId !== undefined && normal.turnId === telemetry.turnId
  }
  return normal.segmentIndex === telemetry.segmentIndex
    && Number.isFinite(normal.recordIndex) && Number.isFinite(telemetry.recordIndex)
    && Math.abs(normal.recordIndex - telemetry.recordIndex) <= 4
}

/**
 * Flatten segments, recover telemetry-only user turns, and fold cumulative
 * copies. The returned records retain non-enumerable segment provenance for
 * diagnostics and conservative identity decisions.
 */
export function prepareRecords(segments) {
  const all = []
  for (const [segmentIndex, segment] of (segments ?? []).entries()) {
    for (const [recordIndex, record] of (segment.records ?? []).entries()) {
      const copy = { ...record }
      Object.defineProperties(copy, {
        __segmentIndex: { value: segmentIndex, enumerable: false },
        __recordIndex: { value: recordIndex, enumerable: false },
      })
      all.push(copy)
    }
  }

  // A normal response item is the authoritative copy of a mirrored telemetry
  // event. Match by turn/id when available; body text alone must never erase a
  // legitimate repeated prompt from another turn.
  const normalUsers = all.map(responseUserDescriptor).filter(Boolean)
  const normalAssistants = all.map(responseAssistantDescriptor).filter(Boolean)
  const matchedNormalUsers = new Set()
  const matchedNormalAssistants = new Set()
  const telemetryKeys = new Set()
  const assistantTelemetryKeys = new Set()
  const syntheticUsers = []
  const syntheticAssistants = []
  for (const record of all) {
    if (record?.type !== 'event_msg') continue
    const normalizedUser = eventUserPayload(record.payload)
    if (normalizedUser !== undefined) {
      const key = contentKey(normalizedUser.payload.content, 'user')
      if (key !== undefined) {
        const turnId = normalizedUser.turnId ?? turnIdOf(record.payload)
        const descriptor = {
          key,
          id: stringId(normalizedUser.payload?.id),
          turnId,
          segmentIndex: record.__segmentIndex,
          recordIndex: record.__recordIndex,
        }
        const normalIndex = normalUsers.findIndex((normal, index) =>
          !matchedNormalUsers.has(index) && telemetryMatchesNormal(normal, descriptor))
        if (normalIndex !== -1) {
          matchedNormalUsers.add(normalIndex)
        } else {
          const telemetryKey = turnId === undefined
            ? `record:${record.__segmentIndex ?? ''}:${record.__recordIndex ?? record.ordinal ?? ''}\u0000${key}`
            : `turn:${turnId}\u0000${key}`
          if (!telemetryKeys.has(telemetryKey)) {
            telemetryKeys.add(telemetryKey)
            const baseOrdinal = typeof record.ordinal === 'number'
              ? record.ordinal : Number.isFinite(record.__recordIndex) ? record.__recordIndex : 0
            const synthetic = {
              timestamp: record.timestamp,
              ordinal: baseOrdinal - 0.001,
              type: 'response_item',
              payload: turnId === undefined ? normalizedUser.payload
                : { ...normalizedUser.payload, turn_id: turnId },
            }
            Object.defineProperties(synthetic, {
              __segmentIndex: { value: record.__segmentIndex, enumerable: false },
              __recordIndex: { value: (record.__recordIndex ?? 0) - 0.001, enumerable: false },
              __telemetryFallback: { value: true, enumerable: false },
            })
            syntheticUsers.push(synthetic)
          }
        }
      }
    }

    // `item_completed.AgentMessage` is the durable telemetry mirror for an
    // assistant response in newer Codex builds. Recover it only when no
    // response_item carries the same turn/id/body, so normal logs stay
    // byte-for-byte equivalent while interrupted tails remain visible.
    const normalizedAssistant = eventAssistantPayload(record.payload)
    if (normalizedAssistant === undefined) continue
    const key = contentKey(normalizedAssistant.payload.content, 'assistant')
    if (key === undefined) continue
    const turnId = normalizedAssistant.turnId ?? turnIdOf(record.payload)
    const descriptor = {
      key,
      id: stringId(normalizedAssistant.payload?.id),
      turnId,
      segmentIndex: record.__segmentIndex,
      recordIndex: record.__recordIndex,
    }
    const normalIndex = normalAssistants.findIndex((normal, index) =>
      !matchedNormalAssistants.has(index) && telemetryMatchesNormal(normal, descriptor))
    if (normalIndex !== -1) {
      matchedNormalAssistants.add(normalIndex)
      continue
    }
    const telemetryKey = descriptor.id !== undefined
      ? `id:${descriptor.id}\u0000${key}`
      : turnId === undefined
        ? `record:${record.__segmentIndex ?? ''}:${record.__recordIndex ?? record.ordinal ?? ''}\u0000${key}`
        : `turn:${turnId}\u0000${key}`
    if (assistantTelemetryKeys.has(telemetryKey)) continue
    assistantTelemetryKeys.add(telemetryKey)
    const baseOrdinal = typeof record.ordinal === 'number'
      ? record.ordinal : Number.isFinite(record.__recordIndex) ? record.__recordIndex : 0
    const synthetic = {
      timestamp: record.timestamp,
      ordinal: baseOrdinal - 0.001,
      type: 'response_item',
      payload: turnId === undefined ? normalizedAssistant.payload
        : { ...normalizedAssistant.payload, turn_id: turnId },
    }
    Object.defineProperties(synthetic, {
      __segmentIndex: { value: record.__segmentIndex, enumerable: false },
      __recordIndex: { value: (record.__recordIndex ?? 0) - 0.001, enumerable: false },
      __telemetryFallback: { value: true, enumerable: false },
    })
    syntheticAssistants.push(synthetic)
  }
  all.push(...syntheticUsers, ...syntheticAssistants)

  // Fork/resume rollouts can be cumulative. Fold exact records and explicit
  // message ids before ordering, while retaining repeated id-less prompts.
  const seenRecords = new Set()
  // Keep fingerprints per role/id. A malformed source can reuse an id for a
  // changed message; silently dropping the later payload would lose content.
  const seenMessageIds = new Map()
  const seenStructuralMessages = new Set()
  const deduped = []
  for (const record of all) {
    const payload = record?.payload
    const role = record?.type === 'response_item' ? messageRole(payload) : undefined
    const explicitMessageId = role === undefined
      ? undefined : stringId(payload?.id ?? payload?.message_id ?? payload?.messageId)
    const fingerprint = role === undefined ? undefined : messageFingerprint(payload)
    const idKey = explicitMessageId === undefined ? undefined : `${role}:${explicitMessageId}`
    const structuralKey = explicitMessageId === undefined
      ? structuralMessageKey(record, fingerprint) : undefined
    let exact
    try { exact = JSON.stringify(record) } catch { exact = undefined }
    if (exact !== undefined && seenRecords.has(exact)) continue
    if (idKey !== undefined && fingerprint !== undefined) {
      const fingerprints = seenMessageIds.get(idKey)
      if (fingerprints?.has(fingerprint)) continue
      if (fingerprints === undefined) seenMessageIds.set(idKey, new Set([fingerprint]))
      else fingerprints.add(fingerprint)
    }
    if (structuralKey !== undefined && seenStructuralMessages.has(structuralKey)) continue
    if (structuralKey !== undefined) seenStructuralMessages.add(structuralKey)
    if (exact !== undefined) seenRecords.add(exact)
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

  const generatedImageKeys = new Map()
  for (const record of all) {
    const payload = record?.payload
    const type = normalizeItemType(payload?.type)
    if (record?.type === 'response_item'
      && (type === 'image_generation_call' || type === 'image_generation_call_output'
        || type === 'image_generation_output' || type === 'imageGeneration')) {
      const callId = stringId(payload.call_id ?? payload.callId ?? payload.id ?? payload.item_id)
      const image = generatedImageOf(payload)
      if (callId !== undefined && image !== undefined) generatedImageKeys.set(callId, image.key)
    } else if (record?.type === 'event_msg') {
      const candidates = [payload, payload?.event, payload?.data, payload?.item]
        .filter((candidate) => candidate !== null && typeof candidate === 'object')
      for (const candidate of candidates) {
        const eventType = normalizeItemType(candidate.type)
        if (!String(eventType).toLowerCase().replace(/[_-]/g, '').includes('imagegeneration')) continue
        const callId = stringId(candidate.call_id ?? candidate.callId ?? candidate.item_id
          ?? candidate.id ?? payload?.call_id ?? payload?.callId ?? payload?.item_id)
        const image = generatedImageOf(candidate) ?? generatedImageOf(payload)
        if (callId !== undefined && image !== undefined) generatedImageKeys.set(callId, image.key)
      }
    }
  }
  return { records: all, duplicateRecords, generatedImageKeys }
}

/**
 * Count raw tool-call ids before conversion. A duplicated id needs ordered
 * telemetry outcome queues; a unique id can use the aggregate outcome map.
 * Keeping this scan beside record normalization avoids growing the conversion
 * state machine with source-shape details.
 */
export function collectRawCallCounts(records) {
  const counts = new Map()
  const callItemTypes = new Set([
    'function_call', 'custom_tool_call', 'commandExecution', 'fileChange', 'mcpToolCall',
    'dynamicToolCall', 'webSearch', 'local_shell_call', 'shell_call', 'tool_search_call',
    'web_search_call', 'image_generation_call', 'imageGeneration',
  ])
  const count = (raw) => {
    const key = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim()
      : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const record of records ?? []) {
    if (record?.type !== 'response_item') continue
    const payload = record.payload ?? {}
    const itemType = normalizeItemType(payload.type)
    if (callItemTypes.has(itemType)) {
      count(payload.call_id ?? payload.callId ?? payload.id)
      continue
    }
    if (itemType === 'message' || itemType === 'userMessage' || itemType === 'agentMessage' || itemType === 'plan') {
      for (const block of inlineToolBlocks(normalizeMessageContent(messageContentOf(payload)))) count(block.id)
    }
  }
  return counts
}
