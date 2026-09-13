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
import { imageIdentities } from './codex-images.js'
import {
  normalizeMessageContent, messageContentOf, messageRole, turnIdOf,
  userText, eventUserPayload,
} from './codex-message.js'

/** Identify image blocks without decoding their bytes during an inventory scan. */
function imageIdentity(content) {
  // Keep only fixed-size identities in the inventory. A 64 MB data URL must
  // not stay referenced by a list row after its record is processed.
  return imageIdentities(content)
}

/** Return a displayable human prompt, preserving image-only turns. */
function promptEntry(content) {
  const normalized = normalizeMessageContent(content)
  const human = userText(textOf(normalized))
  const text = typeof human === 'string' ? human.trim() : ''
  const images = imageIdentity(normalized)
  if (text.length === 0 && images.length === 0) return undefined
  return {
    text: text.length > 0 ? text : '[image]',
    // The key is only for list-time de-duplication. It deliberately avoids
    // decoding base64, so listing a corpus cannot allocate image-sized buffers.
    key: JSON.stringify({ text, images }),
  }
}

function responseUserPayload(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const role = messageRole(payload)
  return role === 'user' ? payload : undefined
}

/** Identity for an id-less prompt copied into cumulative rollout segments. */
function structuralPromptKey(payload, record, entryKey) {
  const turnId = turnIdOf(payload)
  const timestamp = typeof record?.timestamp === 'string' ? record.timestamp : ''
  const ordinal = Number.isFinite(record?.ordinal) ? String(record.ordinal) : ''
  if (turnId === undefined && timestamp.length === 0 && ordinal.length === 0) return undefined
  return `${entryKey}:${turnId ?? ''}:${timestamp}:${ordinal}`
}

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
    const historyPrompts = []
    const telemetryPrompts = []
    const responseIds = new Map()
    const responseStructuralKeys = new Set()
    const historyIds = new Set()
    const historyExact = new Set()
    const telemetryKeys = new Set()
    let recordOrder = 0
    const addMessagePrompt = (payload, order, segmentIndex, fromHistory = false, record = undefined, historyOccurrence = 0) => {
      const entry = promptEntry(messageContentOf(payload))
      if (entry === undefined) return
      const id = stringId(payload?.id ?? payload?.message_id ?? payload?.messageId)
      const role = messageRole(payload) ?? payload?.role ?? 'user'
      const prompt = {
        ...entry,
        bodyKey: entry.key,
        id,
        turnId: turnIdOf(payload),
        order,
        segmentIndex,
        source: fromHistory ? 'history' : 'response',
      }
      if (fromHistory) {
        // History is a snapshot, so exact duplicate entries are safe to fold;
        // repeated prompts with the same text but different positions must
        // remain visible.  Ids are globally unique in Codex and are the only
        // body-independent identity we trust here.
        let exact
        try {
          exact = id === undefined
            ? JSON.stringify({ role, body: entry.key, turnId: turnIdOf(payload), occurrence: historyOccurrence })
            : JSON.stringify({ id, role, body: entry.key })
        } catch { exact = undefined }
        if (exact !== undefined && historyExact.has(exact)) return
        const historyId = id === undefined ? undefined : `${role}:${id}`
        if (historyId !== undefined && historyIds.has(historyId)) return
        if (exact !== undefined) historyExact.add(exact)
        if (historyId !== undefined) historyIds.add(historyId)
        historyPrompts.push(prompt)
        return
      }
      if (id !== undefined) {
        const identity = `${role}:${id}:${entry.key}`
        if (responseIds.has(identity)) return
        responseIds.set(identity, true)
      } else {
        // Forked segments often repeat an id-less response item. Fold only
        // when the source gives us the same turn/position; a same-text prompt
        // at a different position is a legitimate repeated user turn.
        const structural = structuralPromptKey(payload, record, entry.key)
        if (structural !== undefined && responseStructuralKeys.has(structural)) return
        if (structural !== undefined) responseStructuralKeys.add(structural)
      }
      responsePrompts.push(prompt)
    }
    for (const [segmentIndex, segment] of reference.segments.entries()) {
      for (const record of readRecordStream(segment.path)) {
        const order = recordOrder++
        if (record.type === 'session_meta' && record.payload !== null
          && typeof record.payload === 'object') meta = record.payload
        if (typeof record.timestamp === 'string') {
          const timestamp = Date.parse(record.timestamp)
          if (Number.isFinite(timestamp) && (!Number.isFinite(lastMs) || timestamp > lastMs)) {
            lastAt = record.timestamp
            lastMs = timestamp
          }
        }
        if (record.type === 'response_item') {
          const payload = responseUserPayload(record.payload)
          if (payload !== undefined) addMessagePrompt(payload, order, segmentIndex, false, record)
        } else if (record.type === 'compacted') {
          const history = record.payload?.replacement_history ?? record.payload?.replacementHistory
          const historyOccurrences = new Map()
          if (Array.isArray(history)) {
            for (const [index, payload] of history.entries()) {
              if (responseUserPayload(payload) === undefined) continue
              const entry = promptEntry(messageContentOf(payload))
              if (entry === undefined) continue
              const occurrenceBase = `${messageRole(payload) ?? 'user'}\u0000${turnIdOf(payload) ?? ''}\u0000${entry.key}`
              const occurrence = historyOccurrences.get(occurrenceBase) ?? 0
              historyOccurrences.set(occurrenceBase, occurrence + 1)
              addMessagePrompt(payload, order + (index + 1) / (history.length + 1), segmentIndex, true, record, occurrence)
            }
          }
        } else if (record.type === 'event_msg') {
          const normalized = eventUserPayload(record.payload)
          const entry = normalized === undefined ? undefined : promptEntry(normalized.payload.content)
          if (entry !== undefined) {
            const turnKey = normalized.turnId ?? turnIdOf(record.payload)
              ?? `record:${segmentIndex}:${record.ordinal ?? order}`
            const key = `${turnKey}\u0000${entry.key}`
            if (!telemetryKeys.has(key)) {
              telemetryKeys.add(key)
              telemetryPrompts.push({
                ...entry,
                bodyKey: entry.key,
                turnId: normalized.turnId ?? turnIdOf(record.payload),
                order,
                segmentIndex,
                source: 'telemetry',
              })
            }
          }
        }
      }
    }
    // A normal response_item is authoritative for a mirrored telemetry or
    // compaction entry. Match one copy at a time so repeated prompts with the
    // same text are not globally collapsed.
    const basePrompts = [...responsePrompts]
    const matchedBase = new Set()
    const samePrompt = (left, right) => {
      if (left.bodyKey !== right.bodyKey) return false
      if (left.id !== undefined && right.id !== undefined && left.id === right.id) return true
      if (left.turnId !== undefined && right.turnId !== undefined) return left.turnId === right.turnId
      if (left.id !== undefined || right.id !== undefined) return false
      if (left.turnId !== undefined || right.turnId !== undefined) {
        return left.turnId !== undefined && left.turnId === right.turnId
      }
      // Legacy telemetry did not carry a turn id. In that format a mirrored
      // event is adjacent to its response item; use a small positional window
      // so two legitimate repeated prompts farther apart remain distinct.
      return left.segmentIndex === right.segmentIndex && Math.abs(left.order - right.order) <= 4
    }
    const recoveredHistory = []
    for (const history of historyPrompts) {
      const duplicate = basePrompts.findIndex((prompt, index) => !matchedBase.has(index)
        && samePrompt(prompt, history))
      if (duplicate !== -1) {
        matchedBase.add(duplicate)
        continue
      }
      recoveredHistory.push(history)
    }
    const prompts = [...basePrompts, ...recoveredHistory]
    const matchedPrompt = new Set()
    const processedTelemetry = new Set()
    for (const [telemetryIndex, telemetry] of telemetryPrompts.entries()) {
      const priorTelemetry = telemetryPrompts
        .slice(0, telemetryIndex)
        .find((prior) => prior.bodyKey === telemetry.bodyKey
          && ((telemetry.turnId !== undefined && prior.turnId === telemetry.turnId)
            || (telemetry.turnId === undefined && prior.turnId === undefined
              && prior.segmentIndex === telemetry.segmentIndex
              && Math.abs(prior.order - telemetry.order) <= 1)))
      if (priorTelemetry !== undefined && processedTelemetry.has(priorTelemetry)) continue
      processedTelemetry.add(telemetry)
      const duplicate = prompts.findIndex((prompt, index) => !matchedPrompt.has(index)
        && samePrompt(prompt, telemetry))
      if (duplicate !== -1) {
        matchedPrompt.add(duplicate)
        continue
      }
      // A telemetry-only turn can emit two wrappers. Fold only an exact turn
      // identity; without one, a nearby duplicate is the same event in older
      // rollout formats, while a distant repeated prompt is retained.
      prompts.push(telemetry)
    }
    prompts.sort((a, b) => a.order - b.order)
    for (const prompt of prompts) {
      if (promptCount === 0) firstPrompt = prompt.text
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
