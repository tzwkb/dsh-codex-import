/**
 * Bounded-memory conversation inventory and lazy loading.
 *
 * Discovery returns file references; this module groups those references by
 * lineage and only reads full records when a caller asks to iterate a selected
 * conversation.  The converter and the list command share the same inventory
 * contract, so neither path can accidentally drift in how ids are resolved.
 *
 * @module dsh-codex-import/codex-inventory
 */
import {
  findRollouts, readRecordStream, readRecords, stringId,
  readRolloutMetadata, projectMatches, timestampOrder,
} from './codex-discovery.js'
import { textOf } from './codex-payload.js'
import { userText, eventUserPayload } from './codex-message.js'

/** Group rollout paths into lightweight conversation references. */
export function collectConversationRefs(rollouts, sessionIds = []) {
  const requested = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
  const selected = new Set(requested.map(stringId).filter((id) => id !== undefined))
  const bySession = new Map()
  for (const file of rollouts) {
    // The id filter is decided from the bounded metadata prefix alone, so
    // targeting a few sessions never reads the rest of a multi-GB corpus.
    const info = readRolloutMetadata(file.path)
    if (info.rootId === undefined || info.isSubagent) continue
    const rootId = info.rootId
    if (!bySession.has(rootId)) {
      bySession.set(rootId, {
        sessionId: rootId,
        sourceIds: new Set(),
        segments: [],
        cwd: info.cwd,
        provider: info.provider,
        model: info.model,
      })
    }
    const conversation = bySession.get(rootId)
    for (const id of info.sourceIds) conversation.sourceIds.add(id)
    if (conversation.cwd.length === 0 && info.cwd.length > 0) conversation.cwd = info.cwd
    if (conversation.provider.length === 0 && info.provider.length > 0) conversation.provider = info.provider
    if (conversation.model.length === 0 && info.model.length > 0) conversation.model = info.model
    conversation.segments.push({
      path: file.path,
      firstTs: info.firstTs,
      stamp: file.stamp,
      archived: file.archived === true,
      ownId: info.ownId,
      sourceIds: info.sourceIds,
      metadata: info.payloads,
    })
  }
  for (const conversation of bySession.values()) {
    conversation.segments.sort((a, b) => timestampOrder(a.firstTs) - timestampOrder(b.firstTs)
      || a.firstTs.localeCompare(b.firstTs) || a.path.localeCompare(b.path))
    conversation.sourceIds = [...conversation.sourceIds].sort()
  }
  return [...bySession.values()]
    .filter((conversation) => selected.size === 0
      || conversation.sourceIds.some((id) => selected.has(id)))
    .sort((a, b) => (
      timestampOrder(a.segments[0].firstTs) - timestampOrder(b.segments[0].firstTs)
        || a.segments[0].firstTs.localeCompare(b.segments[0].firstTs)
        || a.sessionId.localeCompare(b.sessionId)
    ))
}

/** Load one reference into the record-bearing shape used by the converter. */
export function loadConversation(reference) {
  return {
    sessionId: reference.sessionId,
    sourceIds: reference.sourceIds,
    cwd: reference.cwd,
    provider: reference.provider,
    model: reference.model,
    segments: reference.segments.map((segment) => ({
      path: segment.path,
      firstTs: segment.firstTs,
      stamp: segment.stamp,
      archived: segment.archived,
      ownId: segment.ownId,
      sourceIds: segment.sourceIds,
      metadata: segment.metadata,
      records: readRecords(segment.path),
    })),
  }
}

/** Yield one fully loaded conversation at a time. */
export function* iterateConversations(rollouts, sessionIds = []) {
  const refs = rollouts.length > 0 && rollouts[0]?.sessionId !== undefined
    ? rollouts
    : collectConversationRefs(rollouts, sessionIds)
  for (const reference of refs) yield loadConversation(reference)
}

/** Eager compatibility API for callers that explicitly want all records. */
export function collectConversations(rollouts, sessionIds = []) {
  return [...iterateConversations(rollouts, sessionIds)]
}

/** Inventory conversations without converting or writing them. */
export function listConversations({ sinceHours = 24, codexRoot, includeArchived = false, project } = {}) {
  const rollouts = findRollouts(sinceHours, codexRoot, { includeArchived })
  const rows = []
  for (const reference of collectConversationRefs(rollouts, [])) {
    if (!projectMatches(reference.cwd, project)) continue
    let meta = {}
    const firstTs = reference.segments[0]?.firstTs ?? ''
    let lastAt = firstTs
    let lastMs = Date.parse(lastAt)
    let firstPrompt = ''
    let promptCount = 0
    const responsePrompts = []
    const telemetryPrompts = []
    for (const segment of reference.segments) {
      for (const record of readRecordStream(segment.path)) {
        if (record.type === 'session_meta' && record.payload !== undefined) meta = record.payload
        if (typeof record.timestamp === 'string') {
          const timestamp = Date.parse(record.timestamp)
          if (Number.isFinite(timestamp) && (!Number.isFinite(lastMs) || timestamp > lastMs)) {
            lastAt = record.timestamp
            lastMs = timestamp
          }
        }
        if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
          const prompt = userText(textOf(record.payload.content))
          if (prompt !== undefined && prompt.length > 0) responsePrompts.push(prompt)
        } else if (record.type === 'event_msg') {
          const normalized = eventUserPayload(record.payload)
          const prompt = normalized === undefined ? undefined : userText(normalized.text)
          if (prompt !== undefined && prompt.length > 0) telemetryPrompts.push(prompt)
        }
      }
    }
    // A normal response_item is authoritative when present; event_msg is a
    // crash-safe fallback for rollouts that flushed only telemetry.
    const prompts = responsePrompts.length > 0 ? responsePrompts : [...new Set(telemetryPrompts)]
    for (const prompt of prompts) {
      if (promptCount === 0) firstPrompt = prompt
      promptCount += 1
    }
    rows.push({
      sessionId: reference.sessionId,
      cwd: typeof meta.cwd === 'string' && meta.cwd.length > 0 ? meta.cwd : reference.cwd ?? '',
      archived: reference.segments.some((segment) => segment.archived === true),
      segments: reference.segments.length,
      startedAt: firstTs,
      lastAt,
      prompt: firstPrompt.replace(/\s+/g, ' ').slice(0, 70),
      prompts: promptCount,
    })
  }
  return { rollouts: rollouts.length, rows }
}

export { findRollouts, projectMatches }
