/**
 * Match compacted Codex history snapshots to ordinary response items.
 *
 * Compaction snapshots are a second representation of the transcript. This
 * module owns the one-to-one matching rules that keep snapshots from creating
 * duplicate user or assistant messages while retaining genuinely new text.
 *
 * @module dsh-codex-import/codex-history
 */
import {
  normalizeMessageContent, messageContentOf, messageRole, turnIdOf,
} from './codex-message.js'
import { textOf } from './codex-payload.js'
import { stringId } from './codex-discovery.js'

/** Return a comparable identity for a message snapshot or normal item. */
export function messageDescriptor(payload, record) {
  const role = messageRole(payload)
  if (role === undefined) return undefined
  let body
  try {
    body = JSON.stringify(normalizeMessageContent(messageContentOf(payload)))
  } catch {
    body = textOf(messageContentOf(payload))
  }
  return {
    role,
    body,
    id: stringId(payload?.id ?? payload?.message_id ?? payload?.messageId),
    turnId: turnIdOf(payload),
    segmentIndex: record?.__segmentIndex,
    recordIndex: record?.__recordIndex,
  }
}

/**
 * Create a stateful matcher for compaction entries.
 *
 * Each ordinary response item can satisfy at most one history entry. This is
 * needed for repeated prompts with the same body and for snapshots that carry
 * the same message more than once with different telemetry wrappers.
 */
export function createHistoryMatcher(records) {
  const normalMessageDescriptors = records
    .filter((record) => record.type === 'response_item')
    .map((record) => messageDescriptor(record.payload, record))
    .filter(Boolean)
  const knownMessageIds = new Map()
  for (const descriptor of normalMessageDescriptors) {
    if (descriptor.id === undefined) continue
    const key = `${descriptor.role}:${descriptor.id}`
    const bodies = knownMessageIds.get(key)
    if (bodies === undefined) knownMessageIds.set(key, new Set([descriptor.body]))
    else bodies.add(descriptor.body)
  }
  const matchedNormalHistory = new Set()

  const matchesNormal = (entry, record) => {
    const descriptor = messageDescriptor(entry, record)
    if (descriptor === undefined) return false
    if (descriptor.id !== undefined) {
      const known = knownMessageIds.get(`${descriptor.role}:${descriptor.id}`)
      if (known?.has(descriptor.body)) {
        const matchingIndex = normalMessageDescriptors.findIndex((normal, index) =>
          !matchedNormalHistory.has(index)
          && normal.role === descriptor.role
          && normal.id === descriptor.id
          && normal.body === descriptor.body)
        if (matchingIndex !== -1) matchedNormalHistory.add(matchingIndex)
        // Even after the normal copy has been consumed, an explicit id/body
        // pair remains a snapshot duplicate and must not be emitted again.
        return true
      }
      // Reused ids with changed content are malformed updates; keep the new
      // body visible instead of silently dropping it as an old snapshot.
      if (known !== undefined) return false
    }
    const candidates = normalMessageDescriptors
      .map((normal, index) => ({ normal, index }))
      .filter(({ normal, index }) => !matchedNormalHistory.has(index)
        && normal.role === descriptor.role && normal.body === descriptor.body)
    if (candidates.length === 0) return false
    if (descriptor.turnId !== undefined || candidates.some((candidate) => candidate.normal.turnId !== undefined)) {
      if (descriptor.turnId === undefined) return false
      const matching = candidates.find((candidate) => candidate.normal.turnId === descriptor.turnId)
      if (matching === undefined) return false
      matchedNormalHistory.add(matching.index)
      return true
    }
    // A different explicit id is evidence of a distinct turn. Do not let a
    // body-only fallback erase it merely because the text happens to match.
    if (descriptor.id !== undefined
      && candidates.some(({ normal }) => normal.id !== undefined && normal.id !== descriptor.id)
      && candidates.every(({ normal }) => normal.id !== undefined)) return false
    if (candidates.length === 1) {
      matchedNormalHistory.add(candidates[0].index)
      return true
    }
    const baseIndex = record?.__recordIndex
    const matching = candidates.find(({ normal }) => normal.segmentIndex === record?.__segmentIndex
      && Number.isFinite(baseIndex) && Number.isFinite(normal.recordIndex)
      && Math.abs(normal.recordIndex - baseIndex) <= 4)
    if (matching === undefined) return false
    matchedNormalHistory.add(matching.index)
    return true
  }

  return { messageDescriptor, normalMessageDescriptors, matchesNormal }
}
