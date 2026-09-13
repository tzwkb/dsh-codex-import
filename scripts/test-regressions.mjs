#!/usr/bin/env node
/**
 * Focused regression checks for the bulk-import and rollback paths.
 *
 * The fixture is deliberately tiny, but it exercises the same file layout as
 * Codex. Keeping this separate from the corpus tests makes the edge cases
 * deterministic and lets CI run without a user's ~/.codex directory.
 */
import {
  rmSync, mkdirSync, writeFileSync, readFileSync,
  cpSync, statSync, existsSync, readdirSync, symlinkSync, lstatSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import {
  collectConversationRefs, iterateConversations, listConversations, collectImages,
  findRollouts, runImport, buildRecords, sessionBody, serializeSession, bodySha256,
  sessionDirFor, encodeSegment, projectKey,
} from '../lib/convert.js'
import { assertSafeRoot, syncSessions, writeManifest, rollbackManifest, legacyManifestPath, rollbackResultPath, statePath, manifestPath } from '../lib/sync.js'
import { readSessionLog, decodeFrames, verifyPaths, findLogs, assertToolCallPairing } from '../lib/verify.js'
import { sessionsRoot, groupIntoWorkspaces } from '../lib/index.js'
import { customToolArguments, outputIsError, outputText } from '../lib/codex-payload.js'
import { decodeDataUrl, generatedImageOf, MAX_IMAGE_BYTES } from '../lib/codex-images.js'
import { itemFailed, userText } from '../lib/codex-message.js'
import { isSubagentMetadata, projectMatches, readRecords } from '../lib/codex-discovery.js'
import { makeTestRoot, cleanTestRoot } from './test-env.mjs'

const root = makeTestRoot('codex-regression')
const codexRoot = join(root, 'codex', 'sessions')
mkdirSync(codexRoot, { recursive: true })

const now = new Date()
// Codex names rollouts with local wall-clock time (the payload timestamp is
// UTC), so build the fixture name in the same timezone as the discovery code.
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  + `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
const fileFor = (id, suffix = id) => join(codexRoot, `rollout-${stamp}-${suffix}.jsonl`)
// Keep lineage fixtures outside the ordinary one-hour inventory so the
// original discovery/list checks remain focused on their two baseline files;
// targeted lineage checks opt into the wide window explicitly.
const oldFileFor = (suffix) => join(codexRoot, `rollout-2000-01-01T00-00-00-${suffix}.jsonl`)
const record = (id, ordinal, type, payload, timestamp = now.toISOString()) =>
  JSON.stringify({ timestamp, ordinal, type, payload })
const writeRollout = (path, id, prompt, output = 'ok', image = false) => {
  const lines = [
    record(id, 0, 'session_meta', {
      session_id: id, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
      timestamp: now.toISOString(),
    }),
    record(id, 1, 'event_msg', { type: 'task_started' }),
    record(id, 2, 'response_item', {
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: prompt },
        ...(image ? [{ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }] : []),
      ],
    }),
    record(id, 3, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }),
    record(id, 4, 'event_msg', { type: 'task_complete' }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
}

const idA = '01999999-aaaa-7bbb-8ccc-000000000001'
const idB = '01999999-aaaa-7bbb-8ccc-000000000002'
const imageId = '01999999-aaaa-7bbb-8ccc-000000000003'
const orphanId = '01999999-aaaa-7bbb-8ccc-000000000004'
const pendingId = '01999999-aaaa-7bbb-8ccc-000000000005'
const shellId = '01999999-aaaa-7bbb-8ccc-000000000006'
const eventOnlyId = '01999999-aaaa-7bbb-8ccc-000000000007'
const lineageRootId = '01999999-aaaa-7bbb-8ccc-000000000011'
const lineageChildId = '01999999-aaaa-7bbb-8ccc-000000000012'
const subagentId = '01999999-aaaa-7bbb-8ccc-000000000013'
const archivedId = '01999999-aaaa-7bbb-8ccc-000000000014'
const customToolId = '01999999-aaaa-7bbb-8ccc-000000000015'
const generatedImageId = '01999999-aaaa-7bbb-8ccc-000000000016'
const telemetryId = '01999999-aaaa-7bbb-8ccc-000000000017'
const richSchemaId = '01999999-aaaa-7bbb-8ccc-000000000018'
const modelSwitchId = '01999999-aaaa-7bbb-8ccc-000000000019'
const nestedOutcomeId = '01999999-aaaa-7bbb-8ccc-000000000020'
const compressedId = '01999999-aaaa-7bbb-8ccc-000000000021'
const telemetryUserId = '01999999-aaaa-7bbb-8ccc-000000000022'
const duplicateUserId = '01999999-aaaa-7bbb-8ccc-000000000023'
const lifecycleId = '01999999-aaaa-7bbb-8ccc-000000000025'
const searchPlaceholderId = '01999999-aaaa-7bbb-8ccc-000000000026'
const nullMetadataId = '01999999-aaaa-7bbb-8ccc-000000000027'
const telemetryImageOnlyId = '01999999-aaaa-7bbb-8ccc-000000000028'
const nestedTelemetryUserId = '01999999-aaaa-7bbb-8ccc-000000000029'
const compactionId = '01999999-aaaa-7bbb-8ccc-000000000030'
const repeatedPromptId = '01999999-aaaa-7bbb-8ccc-000000000031'
const aliasSchemaId = '01999999-aaaa-7bbb-8ccc-000000000032'
const splitCompressedId = '01999999-aaaa-7bbb-8ccc-000000000033'
const assistantTelemetryId = '01999999-aaaa-7bbb-8ccc-000000000034'
const duplicateCallId = '01999999-aaaa-7bbb-8ccc-000000000035'
const splitInstalledId = '01999999-aaaa-7bbb-8ccc-000000000036'
const duplicateEventCallId = '01999999-aaaa-7bbb-8ccc-000000000038'
const repeatedHistoryId = '01999999-aaaa-7bbb-8ccc-000000000039'
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
writeRollout(fileFor(idA), idA, 'first prompt')
writeRollout(fileFor(idB), idB, 'second prompt')
const invalidPath = join(codexRoot, 'rollout-2026-99-99T99-99-99-invalid.jsonl')
writeRollout(invalidPath, '01999999-aaaa-7bbb-8ccc-000000000099', 'invalid date')

// Current Codex writes `payload.id` and may append a second session_meta that
// points at the conversation root (`id === session_id`). A fork/lineage can
// therefore contribute several rollout files to one DSH session. Keep the
// duplicate message id in both segments so the merger has to fold it once.
const lineageOne = oldFileFor('lineage-child')
const lineageTwo = oldFileFor('lineage-root')
const lineageMeta = (id, extra = {}) => record(id, 0, 'session_meta', {
  id, cwd: '/tmp/lineage-project', model_provider: 'openai', model: 'codex',
  timestamp: now.toISOString(), ...extra,
})
const lineageUser = record(lineageChildId, 2, 'response_item', {
  id: 'message-shared-1', type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'lineage prompt' }],
})
const lineageAssistant = record(lineageChildId, 3, 'response_item', {
  id: 'message-shared-2', type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'lineage answer' }],
})
writeFileSync(lineageOne, [
  lineageMeta(lineageChildId),
  record(lineageChildId, 0.5, 'turn_context', { model: 'gpt-5.5' }),
  lineageMeta(lineageRootId, { session_id: lineageRootId }),
  record(lineageChildId, 1, 'event_msg', { type: 'task_started' }),
  lineageUser,
  lineageAssistant,
  record(lineageChildId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(lineageTwo, [
  lineageMeta(lineageRootId, { session_id: lineageRootId }),
  record(lineageRootId, 1, 'event_msg', { type: 'task_started' }),
  lineageUser,
  lineageAssistant,
  record(lineageRootId, 4, 'response_item', {
    id: 'message-new-3', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'second segment answer' }],
  }),
  record(lineageRootId, 5, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('subagent'), [
  lineageMeta(subagentId, {
    session_id: lineageRootId, thread_source: 'subagent',
    source: { subagent: { parent_thread_id: lineageRootId } },
  }),
  record(subagentId, 1, 'event_msg', { type: 'task_started' }),
  record(subagentId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'subagent only' }],
  }),
  record(subagentId, 3, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
const archivedRoot = join(root, 'codex', 'archived_sessions')
mkdirSync(archivedRoot, { recursive: true })
writeRollout(join(archivedRoot, `rollout-${stamp}-archived.jsonl`), archivedId, 'archived prompt')
writeFileSync(oldFileFor('custom-tool'), [
  record(customToolId, 0, 'session_meta', {
    session_id: customToolId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(customToolId, 1, 'event_msg', { type: 'task_started' }),
  record(customToolId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'custom tool test' }],
  }),
  record(customToolId, 3, 'response_item', {
    type: 'custom_tool_call', call_id: 'custom-call-1', name: 'exec_command',
    input: 'tools.exec_command({command:"ls", opts:{cwd:\'/tmp/project\', verbose:true}})',
  }),
  record(customToolId, 4, 'response_item', {
    type: 'custom_tool_call_output', call_id: 'custom-call-1', output: 'ok',
  }),
  record(customToolId, 5, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('generated-image'), [
  record(generatedImageId, 0, 'session_meta', {
    session_id: generatedImageId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(generatedImageId, 1, 'event_msg', { type: 'task_started' }),
  record(generatedImageId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'generate an image' }],
  }),
  record(generatedImageId, 3, 'response_item', {
    type: 'imageGeneration', id: 'image-call-1', action: { prompt: 'a blue square' },
    result: { b64Json: onePixelPng }, status: 'completed',
  }),
  record(generatedImageId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('telemetry-tail'), [
  record(telemetryId, 0, 'session_meta', {
    id: telemetryId, cwd: '/tmp/telemetry-project', model_provider: 'openai', timestamp: now.toISOString(),
  }),
  record(telemetryId, 1, 'turn_context', { model: 'gpt-5.5' }),
  record(telemetryId, 2, 'event_msg', { type: 'task_started' }),
  record(telemetryId, 3, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tail recovery' }],
  }),
  record(telemetryId, 4, 'event_msg', {
    type: 'task_complete', last_agent_message: 'Recovered from telemetry',
  }),
].join('\n') + '\n')

// Newer App Server/Codex builds use camelCase item names and may put tool-use
// blocks directly inside an assistant message. Keep this fixture outside the
// ordinary one-hour inventory; the targeted checks opt into the wide window.
writeFileSync(oldFileFor('rich-schema'), [
  record(richSchemaId, 0, 'session_meta', {
    id: richSchemaId, cwd: '/tmp/rich-project', model_provider: 'openai',
    model: 'codex-rich', title: 'Rich schema title', timestamp: now.toISOString(),
  }),
  record(richSchemaId, 1, 'event_msg', { type: 'task_started' }),
  record(richSchemaId, 2, 'response_item', {
    type: 'userMessage', id: 'rich-user-1',
    content: [
      { type: 'text', text: 'rich schema prompt' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,' + onePixelPng },
    ],
  }),
  record(richSchemaId, 3, 'response_item', {
    type: 'reasoning', id: 'rich-reasoning-1', summary: ['first thought', 'second thought'],
  }),
  record(richSchemaId, 3.5, 'response_item', {
    type: 'reasoning', id: 'rich-reasoning-2', summary: 'single string thought',
  }),
  record(richSchemaId, 4, 'response_item', {
    type: 'commandExecution', id: 'rich-command-1', command: 'echo rich',
    cwd: '/tmp/rich-project', status: 'completed', aggregatedOutput: 'rich output', exitCode: 0,
  }),
  record(richSchemaId, 4.5, 'response_item', {
    type: 'fileChange', id: 'rich-file-1', status: 'completed',
    changes: [{ path: 'README.md', kind: 'update' }], result: { summary: 'README updated' },
  }),
  record(richSchemaId, 5, 'response_item', {
    type: 'mcpToolCall', id: 'rich-mcp-1', server: 'demo', tool: 'lookup',
    status: 'failed', arguments: { query: 'x' }, result: null, error: { message: 'lookup failed' },
  }),
  record(richSchemaId, 6, 'response_item', {
    type: 'message', id: 'rich-assistant-1', role: 'assistant', content: [
      { type: 'output_text', text: 'inline tool follows' },
      { type: 'toolUse', id: 'rich-inline-1', name: 'exec_command', input: { cmd: 'pwd' } },
    ],
  }),
  record(richSchemaId, 7, 'response_item', {
    type: 'function_call_output', call_id: 'rich-inline-1', output: 'inline output',
  }),
  record(richSchemaId, 8, 'response_item', {
    type: 'agentMessage', id: 'rich-agent-1', text: 'final rich answer', phase: 'final_answer',
  }),
  record(richSchemaId, 9, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

writeFileSync(oldFileFor('model-switch'), [
  record(modelSwitchId, 0, 'session_meta', {
    id: modelSwitchId, cwd: '/tmp/model-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(modelSwitchId, 1, 'turn_context', { turn_id: 'turn-a', model: 'gpt-a' }),
  record(modelSwitchId, 2, 'event_msg', { type: 'task_started', turn_id: 'turn-a' }),
  record(modelSwitchId, 3, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first model' }],
  }),
  record(modelSwitchId, 4, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer a' }],
  }),
  record(modelSwitchId, 5, 'event_msg', { type: 'task_complete' }),
  record(modelSwitchId, 6, 'turn_context', { turn_id: 'turn-b', model: 'gpt-b' }),
  record(modelSwitchId, 7, 'event_msg', { type: 'task_started', turn_id: 'turn-b' }),
  record(modelSwitchId, 8, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second model' }],
  }),
  record(modelSwitchId, 9, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer b' }],
  }),
  record(modelSwitchId, 10, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

writeFileSync(oldFileFor('nested-outcome'), [
  record(nestedOutcomeId, 0, 'session_meta', {
    id: nestedOutcomeId, cwd: '/tmp/nested-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(nestedOutcomeId, 1, 'event_msg', { type: 'task_started' }),
  record(nestedOutcomeId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'nested completion' }],
  }),
  record(nestedOutcomeId, 3, 'response_item', {
    type: 'function_call', call_id: 'nested-call-1', name: 'exec_command', arguments: '{}',
  }),
  record(nestedOutcomeId, 4, 'event_msg', {
    type: 'item_completed', item: {
      id: 'nested-call-1', type: 'commandExecution', status: 'completed',
      aggregatedOutput: 'nested completion output', exitCode: 0,
    },
  }),
  record(nestedOutcomeId, 5, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

// Codex's compaction worker can move cold rollouts to `.jsonl.zst`. Keep one
// compressed fixture so discovery and conversion cannot silently regress to
// plain-jsonl-only support.
const compressedSource = [
  record(compressedId, 0, 'session_meta', {
    id: compressedId, cwd: '/tmp/compressed-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(compressedId, 1, 'event_msg', { type: 'task_started' }),
  record(compressedId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compressed rollout prompt' }],
  }),
  record(compressedId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'compressed rollout answer' }],
  }),
  record(compressedId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n'
const compressedPath = oldFileFor('compressed') + '.zst'
writeFileSync(compressedPath, zstdCompressSync(Buffer.from(compressedSource, 'utf8')))

// A source compressor may rotate frames in the middle of a JSON line. The
// discovery reader must carry its UTF-8/line buffer across those boundaries.
const splitCompressedSource = [
  record(splitCompressedId, 0, 'session_meta', {
    id: splitCompressedId, cwd: '/tmp/split-compressed-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(splitCompressedId, 1, 'event_msg', { type: 'task_started' }),
  record(splitCompressedId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'split frame prompt 分片' }],
  }),
  record(splitCompressedId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'split frame answer' }],
  }),
  record(splitCompressedId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n'
const splitBytes = Buffer.from(splitCompressedSource, 'utf8')
// Deliberately cut inside the three-byte UTF-8 encoding of `片`, not merely at
// a JavaScript character boundary. This catches frame readers that decode each
// compressed member independently and silently replace the split code point.
const splitMarker = Buffer.from('片', 'utf8')
const splitAt = splitBytes.indexOf(splitMarker) + 1
const splitCompressedPath = oldFileFor('split-compressed') + '.zst'
writeFileSync(splitCompressedPath, Buffer.concat([
  zstdCompressSync(splitBytes.subarray(0, splitAt)),
  zstdCompressSync(splitBytes.subarray(splitAt)),
]))
const brokenCompressedPath = oldFileFor('broken-compressed') + '.zst'
writeFileSync(brokenCompressedPath, Buffer.concat([
  zstdCompressSync(Buffer.from(splitCompressedSource, 'utf8')),
  Buffer.from('not-a-zstd-frame'),
]))

const eventUserRollout = (id, name, includeResponse) => {
  const turnId = `${id}-turn`
  const lines = [
    record(id, 0, 'session_meta', {
      id, cwd: `/tmp/${name}-project`, model_provider: 'openai', model: 'codex',
      timestamp: now.toISOString(),
    }),
    record(id, 1, 'event_msg', { type: 'task_started' }),
    record(id, 2, 'event_msg', {
      type: 'user_message', id: `${id}-telemetry-message`, turn_id: turnId,
      message: 'telemetry-only user prompt',
    }),
  ]
  if (includeResponse) {
    lines.push(record(id, 3, 'response_item', {
      type: 'message', id: `${id}-response-message`, role: 'user',
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      content: [{ type: 'input_text', text: 'telemetry-only user prompt' }],
    }))
  }
  lines.push(record(id, includeResponse ? 4 : 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'telemetry answer' }],
  }))
  lines.push(record(id, includeResponse ? 5 : 4, 'event_msg', { type: 'task_complete' }))
  return lines.join('\n') + '\n'
}
writeFileSync(oldFileFor('telemetry-user'), eventUserRollout(telemetryUserId, 'telemetry-user', false))
writeFileSync(oldFileFor('duplicate-user'), eventUserRollout(duplicateUserId, 'duplicate-user', true))
writeFileSync(oldFileFor('null-metadata'), [
  record(nullMetadataId, 0, 'session_meta', {
    id: nullMetadataId, cwd: '/tmp/null-metadata-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(nullMetadataId, 1, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'null metadata prompt' }],
  }),
  record(nullMetadataId, 2, 'session_meta', null),
  record(nullMetadataId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'null metadata answer' }],
  }),
  record(nullMetadataId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('telemetry-image-only'), [
  record(telemetryImageOnlyId, 0, 'session_meta', {
    id: telemetryImageOnlyId, cwd: '/tmp/telemetry-image-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(telemetryImageOnlyId, 1, 'event_msg', { type: 'task_started' }),
  record(telemetryImageOnlyId, 2, 'event_msg', {
    type: 'user_message',
    message: { content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + onePixelPng }] },
  }),
  record(telemetryImageOnlyId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'image received' }],
  }),
  record(telemetryImageOnlyId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('nested-telemetry-user'), [
  record(nestedTelemetryUserId, 0, 'session_meta', {
    id: nestedTelemetryUserId, cwd: '/tmp/nested-telemetry-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(nestedTelemetryUserId, 1, 'event_msg', { type: 'task_started' }),
  record(nestedTelemetryUserId, 2, 'event_msg', {
    type: 'item_completed',
    item: {
      type: 'UserMessage',
      id: 'nested-telemetry-user-message',
      content: [
        { type: 'input_text', text: 'nested telemetry prompt' },
        { type: 'input_image', image_url: 'data:image/png;base64,' + onePixelPng },
      ],
    },
  }),
  record(nestedTelemetryUserId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'nested telemetry answer' }],
  }),
  record(nestedTelemetryUserId, 4, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('compaction-history'), [
  record(compactionId, 0, 'session_meta', {
    id: compactionId, cwd: '/tmp/compaction-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(compactionId, 1, 'event_msg', { type: 'task_started' }),
  record(compactionId, 2, 'compacted', {
    replacement_history: [
      { type: 'message', id: 'history-user-1', role: 'user', content: [{ type: 'input_text', text: 'recovered compaction prompt' }] },
      { type: 'message', id: 'history-assistant-1', role: 'assistant', content: [{ type: 'output_text', text: 'recovered compaction answer' }] },
      { type: 'message', id: 'normal-user-1', role: 'user', content: [{ type: 'input_text', text: 'normal compaction prompt' }] },
      { type: 'compaction' },
    ],
  }),
  record(compactionId, 3, 'response_item', {
    type: 'message', id: 'normal-user-1', role: 'user',
    content: [{ type: 'input_text', text: 'normal compaction prompt' }],
  }),
  record(compactionId, 4, 'response_item', {
    type: 'message', id: 'normal-assistant-1', role: 'assistant',
    content: [{ type: 'output_text', text: 'normal compaction answer' }],
  }),
  record(compactionId, 5, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

// The same human text can legitimately occur in separate turns. A telemetry
// fallback must only mirror its matching turn, rather than being dropped by a
// corpus-wide body-text set.
writeFileSync(oldFileFor('repeated-prompt'), [
  record(repeatedPromptId, 0, 'session_meta', {
    id: repeatedPromptId, cwd: '/tmp/repeated-prompt-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(repeatedPromptId, 1, 'event_msg', { type: 'task_started', turn_id: 'repeat-turn-a' }),
  record(repeatedPromptId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'repeat me' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'repeat-turn-a' },
  }),
  record(repeatedPromptId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }],
  }),
  record(repeatedPromptId, 4, 'event_msg', { type: 'task_complete', turn_id: 'repeat-turn-a' }),
  record(repeatedPromptId, 5, 'event_msg', { type: 'task_started', turn_id: 'repeat-turn-b' }),
  record(repeatedPromptId, 6, 'event_msg', {
    type: 'user_message', turn_id: 'repeat-turn-b', message: 'repeat me',
  }),
  record(repeatedPromptId, 7, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second answer' }],
  }),
  record(repeatedPromptId, 8, 'event_msg', { type: 'task_complete', turn_id: 'repeat-turn-b' }),
].join('\n') + '\n')

// Exercise case, separator, and camelCase aliases together with the alternate
// compaction property spelling used by App Server exports.
writeFileSync(oldFileFor('alias-schema'), [
  record(aliasSchemaId, 0, 'session_meta', {
    id: aliasSchemaId, cwd: '/tmp/alias-schema-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(aliasSchemaId, 1, 'event_msg', { type: 'TASK_STARTED' }),
  record(aliasSchemaId, 2, 'response_item', {
    type: 'USER_MESSAGE', id: 'alias-user-1', text: 'uppercase user message',
  }),
  record(aliasSchemaId, 3, 'response_item', {
    type: 'COMMAND-EXECUTION', id: 'alias-command-1', command: 'echo alias',
    status: 'COMPLETED', aggregatedOutput: 'alias command output', exitCode: 0,
  }),
  record(aliasSchemaId, 4, 'response_item', {
    type: 'AGENTMESSAGE', id: 'alias-agent-1', text: 'uppercase agent answer',
  }),
  record(aliasSchemaId, 5, 'compacted', {
    replacementHistory: [
      { type: 'UserMessage', id: 'alias-history-user', text: 'uppercase history prompt' },
      { type: 'AgentMessage', id: 'alias-history-agent', text: 'uppercase history answer' },
    ],
  }),
  record(aliasSchemaId, 6, 'event_msg', { type: 'TASK_COMPLETE' }),
].join('\n') + '\n')

// Newer Codex builds persist assistant messages in `event_msg.item_completed`
// even when the corresponding response_item was never flushed. Keep a
// telemetry-only fixture (plus a repeated mirror) so an interrupted tail is
// recovered once, without inventing a second assistant message.
writeFileSync(oldFileFor('assistant-telemetry'), [
  record(assistantTelemetryId, 0, 'session_meta', {
    id: assistantTelemetryId, cwd: '/tmp/assistant-telemetry-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(assistantTelemetryId, 1, 'event_msg', { type: 'task_started', turn_id: 'assistant-telemetry-turn' }),
  record(assistantTelemetryId, 2, 'event_msg', {
    type: 'item_completed', turn_id: 'assistant-telemetry-turn', item: {
      type: 'AgentMessage', id: 'assistant-telemetry-message', phase: 'final_answer',
      content: [{ type: 'Text', text: 'assistant recovered from telemetry' }],
    },
  }),
  record(assistantTelemetryId, 3, 'event_msg', {
    type: 'item_completed', turn_id: 'assistant-telemetry-turn', item: {
      type: 'AgentMessage', id: 'assistant-telemetry-message', phase: 'final_answer',
      content: [{ type: 'Text', text: 'assistant recovered from telemetry' }],
    },
  }),
  record(assistantTelemetryId, 4, 'event_msg', { type: 'task_complete', turn_id: 'assistant-telemetry-turn' }),
].join('\n') + '\n')

writeFileSync(oldFileFor('lifecycle-aliases'), [
  record(lifecycleId, 0, 'session_meta', {
    id: lifecycleId, cwd: '/tmp/lifecycle-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(lifecycleId, 1, 'event_msg', { type: 'turn_started', turn_id: 'alias-turn-1' }),
  record(lifecycleId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'alias turn one' }],
  }),
  record(lifecycleId, 3, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer one' }],
  }),
  record(lifecycleId, 4, 'event_msg', { type: 'turn_completed', turn_id: 'alias-turn-1' }),
  record(lifecycleId, 5, 'event_msg', { type: 'turn_start', turn_id: 'alias-turn-2' }),
  record(lifecycleId, 6, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'alias turn two' }],
  }),
  record(lifecycleId, 7, 'response_item', {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer two' }],
  }),
  record(lifecycleId, 8, 'event_msg', { type: 'turn_end', turn_id: 'alias-turn-2' }),
].join('\n') + '\n')
writeFileSync(oldFileFor('search-placeholders'), [
  record(searchPlaceholderId, 0, 'session_meta', {
    id: searchPlaceholderId, cwd: '/tmp/search-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(searchPlaceholderId, 1, 'event_msg', { type: 'task_started' }),
  record(searchPlaceholderId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search placeholder test' }],
  }),
  record(searchPlaceholderId, 3, 'response_item', {
    type: 'web_search_call', call_id: 'web-no-output', action: { query: 'dsh' },
  }),
  record(searchPlaceholderId, 4, 'response_item', {
    type: 'tool_search_call', call_id: 'tool-no-output', arguments: { query: 'lookup' },
  }),
  record(searchPlaceholderId, 5, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

// Malformed exports have occasionally reused a raw call id. The importer must
// preserve both exchanges while assigning DSH-safe, unique ids.
writeFileSync(oldFileFor('duplicate-call-ids'), [
  record(duplicateCallId, 0, 'session_meta', {
    id: duplicateCallId, cwd: '/tmp/duplicate-call-project', model_provider: 'openai', model: 'codex',
    timestamp: now.toISOString(),
  }),
  record(duplicateCallId, 1, 'event_msg', { type: 'task_started' }),
  record(duplicateCallId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate calls' }],
  }),
  record(duplicateCallId, 3, 'response_item', {
    type: 'function_call', call_id: 'same-raw-id', name: 'first_tool', arguments: '{}',
  }),
  record(duplicateCallId, 4, 'response_item', {
    type: 'function_call', call_id: 'same-raw-id', name: 'second_tool', arguments: '{}',
  }),
  record(duplicateCallId, 5, 'response_item', {
    type: 'function_call_output', call_id: 'same-raw-id', output: 'first result',
  }),
  record(duplicateCallId, 6, 'response_item', {
    type: 'function_call_output', call_id: 'same-raw-id', output: 'second result',
  }),
  record(duplicateCallId, 7, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

// Completion telemetry can repeat the same malformed raw id too. Keep the
// ordered event outcomes paired with the renamed calls rather than assigning
// the last completion to the first call and fabricating an error for the next.
writeFileSync(oldFileFor('duplicate-event-call-ids'), [
  record(duplicateEventCallId, 0, 'session_meta', {
    id: duplicateEventCallId, cwd: '/tmp/duplicate-event-call-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(duplicateEventCallId, 1, 'event_msg', { type: 'task_started' }),
  record(duplicateEventCallId, 2, 'response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate event calls' }],
  }),
  record(duplicateEventCallId, 3, 'response_item', {
    type: 'function_call', call_id: 'same-event-raw-id', name: 'first_tool', arguments: '{}',
  }),
  record(duplicateEventCallId, 4, 'response_item', {
    type: 'function_call', call_id: 'same-event-raw-id', name: 'second_tool', arguments: '{}',
  }),
  record(duplicateEventCallId, 5, 'event_msg', {
    type: 'exec_command_end', call_id: 'same-event-raw-id', output: 'first event result',
  }),
  record(duplicateEventCallId, 6, 'event_msg', {
    type: 'exec_command_end', call_id: 'same-event-raw-id', output: 'second event result',
  }),
  record(duplicateEventCallId, 7, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

// A compaction snapshot can contain two legitimate id-less messages with the
// same body. Repeated snapshots should fold as snapshots, while multiplicity
// inside one snapshot must remain visible in both conversion and listing.
const repeatedHistory = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same history prompt' }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same history prompt' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same history answer' }] },
]
writeFileSync(oldFileFor('repeated-history'), [
  record(repeatedHistoryId, 0, 'session_meta', {
    id: repeatedHistoryId, cwd: '/tmp/repeated-history-project', model_provider: 'openai',
    timestamp: now.toISOString(),
  }),
  record(repeatedHistoryId, 1, 'compacted', { replacement_history: repeatedHistory }),
  record(repeatedHistoryId, 2, 'compacted', { replacement_history: repeatedHistory }),
  record(repeatedHistoryId, 3, 'event_msg', { type: 'task_complete' }),
].join('\n') + '\n')

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`)
  }
}

try {
  const rollouts = findRollouts(1, codexRoot)
  await check('bulk discovery keeps only lightweight conversation references', () => {
    const refs = collectConversationRefs(rollouts)
    assert.equal(refs.length, 2)
    assert.equal(refs[0].segments[0].records, undefined)
    assert.equal(refs[0].segments[0].path.endsWith('.jsonl'), true)
    assert.equal(refs.some((ref) => ref.sessionId.endsWith('0099')), false)
  })

  await check('compressed .jsonl.zst rollouts are discovered and converted', async () => {
    const compressedFiles = findRollouts(Number.MAX_SAFE_INTEGER, codexRoot)
      .filter((file) => file.path === compressedPath)
    assert.equal(compressedFiles.length, 1)
    const refs = collectConversationRefs(compressedFiles)
    assert.equal(refs.length, 1)
    assert.equal(refs[0].sessionId, compressedId)
    const out = join(root, 'scratch-compressed')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [compressedId] })
    assert.equal(imported.results.length, 1)
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(events.some((event) => JSON.stringify(event).includes('compressed rollout prompt')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('compressed rollout answer')))
  })

  await check('source zstd frames are streamed across concatenated boundaries', async () => {
    const files = findRollouts(Number.MAX_SAFE_INTEGER, codexRoot)
      .filter((file) => file.path === splitCompressedPath)
    assert.equal(files.length, 1)
    const records = readRecords(splitCompressedPath)
    assert.equal(records.length, 5)
    assert.equal(records[2].payload.content[0].text, 'split frame prompt 分片')
    const out = join(root, 'scratch-split-compressed')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [splitCompressedId] })
    assert.equal(imported.results.length, 1)
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(events.some((event) => JSON.stringify(event).includes('split frame answer')))
  })

  await check('a truncated or appended bad zstd frame is ignored atomically', () => {
    assert.deepEqual(readRecords(brokenCompressedPath), [])
    assert.throws(() => decodeFrames(readFileSync(brokenCompressedPath)), /frame boundary|invalid zstd/i)
  })

  await check('a rollout removed during discovery is treated as an empty stream', () => {
    assert.deepEqual(readRecords(join(codexRoot, 'does-not-exist.jsonl')), [])
  })

  await check('event_msg user_message is recovered only when response_item is absent', async () => {
    const out = join(root, 'scratch-event-user')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [telemetryUserId, duplicateUserId] })
    assert.equal(imported.results.length, 2)
    for (const result of imported.results) {
      const events = decodeFrames(readFileSync(join(result.dir, 'session.v3.jsonl.zstd')))
        .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const users = events.filter((event) => event.type === 'user/message')
      assert.equal(users.length, 1, `${result.id} user count`)
      assert.match(JSON.stringify(users[0]), /telemetry-only user prompt/)
    }
    const listed = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const telemetryRow = listed.rows.find((row) => row.sessionId === telemetryUserId)
    assert.equal(telemetryRow?.prompt, 'telemetry-only user prompt')
  })

  await check('repeated prompts remain distinct across normal and telemetry turns', async () => {
    const out = join(root, 'scratch-repeated-prompt')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [repeatedPromptId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const users = events.filter((event) => event.type === 'user/message')
    assert.equal(users.length, 2)
    const listed = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const row = listed.rows.find((entry) => entry.sessionId === repeatedPromptId)
    assert.equal(row?.prompts, 2)
  })

  await check('id-less repeated prompts at different positions are never folded', () => {
    const ts = now.toISOString()
    const message = (ordinal, text) => ({
      type: 'response_item', timestamp: ts, ordinal,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
    const built = buildRecords([
      { records: [
        { type: 'session_meta', timestamp: ts, ordinal: 0, payload: { id: 'idless-repeat', cwd: '/tmp/idless-repeat' } },
        message(1, 'same body'),
      ] },
      { records: [
        { type: 'session_meta', timestamp: new Date(now.getTime() + 1000).toISOString(), ordinal: 0, payload: { id: 'idless-repeat', cwd: '/tmp/idless-repeat' } },
        message(2, 'same body'),
      ] },
    ], 'idless-repeat')
    assert.equal(built.records.filter((event) => event.type === 'user/message').length, 2)
  })

  await check('reused message ids cannot erase changed content or another role', () => {
    const ts = now.toISOString()
    const source = (ordinal, role, text) => ({
      type: 'response_item', timestamp: ts, ordinal,
      payload: { type: 'message', id: 'reused-message', role, content: [
        { type: role === 'assistant' ? 'output_text' : 'input_text', text },
      ] },
    })
    const built = buildRecords([{ records: [
      { type: 'session_meta', timestamp: ts, ordinal: 0, payload: { id: 'reused-session', cwd: '/tmp/reused' } },
      source(1, 'user', 'first user body'),
      source(2, 'user', 'updated user body'),
      source(3, 'assistant', 'assistant body'),
    ] }], 'reused-session')
    const messages = built.records.filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    assert.equal(messages.length, 3)
    assert.ok(messages.some((event) => JSON.stringify(event).includes('first user body')))
    assert.ok(messages.some((event) => JSON.stringify(event).includes('updated user body')))
    assert.ok(messages.some((event) => JSON.stringify(event).includes('assistant body')))
    assert.equal(new Set(messages.map((event) => event.data.message?.id ?? event.data.id)).size, 3)
  })

  await check('current payload.id lineage is grouped by its root and duplicate messages fold once', async () => {
    const refs = collectConversationRefs(findRollouts(Number.MAX_SAFE_INTEGER, codexRoot), [lineageRootId])
    assert.equal(refs.length, 1)
    assert.equal(refs[0].sessionId, lineageRootId)
    assert.equal(refs[0].segments.length, 2)
    assert.ok(refs[0].sourceIds.includes(lineageChildId))
    assert.ok(refs[0].sourceIds.includes(lineageRootId))

    // Selecting the child id must resolve to the same root conversation.
    const childRefs = collectConversationRefs(findRollouts(Number.MAX_SAFE_INTEGER, codexRoot), [lineageChildId])
    assert.equal(childRefs.length, 1)
    assert.equal(childRefs[0].sessionId, lineageRootId)

    const out = join(root, 'scratch-lineage')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [lineageChildId] })
    assert.equal(imported.results.length, 1, JSON.stringify(imported))
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const messages = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    assert.equal(messages.filter((event) => event.data.message?.id === 'message-shared-1' || event.data.id === 'message-shared-1').length, 1, 'shared user count')
    assert.equal(messages.filter((event) => JSON.stringify(event).includes('lineage answer')).length, 1, 'shared assistant count')
    assert.ok(messages.some((event) => JSON.stringify(event).includes('second segment answer')))
    const title = events.find((event) => event.type === 'session/title')
    assert.ok(title, 'import should pin a session title from the first human prompt')
    assert.equal(title.data.title, 'lineage prompt')
    assert.equal(title.data.source.kind, 'fallback')
    assert.equal(title.data.messageSeqs.length, 1)
  })

  await check('subagent lineage rollouts are excluded from the parent import', () => {
    const refs = collectConversationRefs(findRollouts(Number.MAX_SAFE_INTEGER, codexRoot), [lineageRootId, subagentId])
    assert.equal(refs.length, 1)
    assert.equal(refs[0].sessionId, lineageRootId)
    assert.equal(refs[0].sourceIds.includes(subagentId), false)
  })

  await check('false subagent metadata does not hide a normal rollout', () => {
    assert.equal(isSubagentMetadata({ source: { subagent: false } }), false)
    assert.equal(isSubagentMetadata({ source: { subagent: { parent_thread_id: lineageRootId } } }), true)
  })

  await check('archived sessions are opt-in and selected ids can import them', async () => {
    assert.equal(findRollouts(1, codexRoot).some((file) => file.path.includes('archived_sessions')), false)
    const withArchived = findRollouts(1, codexRoot, { includeArchived: true })
    assert.ok(withArchived.some((file) => file.path.includes('archived_sessions')))
    const out = join(root, 'scratch-archived')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [archivedId], includeArchived: true,
    })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].cwd, '/tmp/project')
  })

  await check('project and limit selectors are applied after lineage grouping', async () => {
    const listed = listConversations({ sinceHours: 1, codexRoot, project: '/tmp/project' })
    assert.ok(listed.rows.length >= 2)
    const outside = listConversations({ sinceHours: 1, codexRoot, project: '/definitely/not/a/project' })
    assert.equal(outside.rows.length, 0)
    const out = join(root, 'scratch-limit')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [idA, idB], limit: 1, project: '/tmp/project',
    })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].id, `session-${idB}`)
  })

  await check('custom tool JavaScript input is converted to parseable JSON arguments', async () => {
    const out = join(root, 'scratch-custom-tool')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [customToolId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const call = events.find((event) => event.type === 'tool/call')
    assert.deepEqual(JSON.parse(call.data.arguments), {
      command: 'ls', opts: { cwd: '/tmp/project', verbose: true },
    })
  })

  await check('custom tool literal parsing cannot mutate object prototypes', () => {
    delete Object.prototype.codexImportPolluted
    const parsed = customToolArguments('tools.exec_command({__proto__: {codexImportPolluted: true}, safe: "ok"})')
    assert.equal(parsed.fallback, true)
    assert.equal({}.codexImportPolluted, undefined)
    assert.equal(Object.prototype.hasOwnProperty('codexImportPolluted'), false)
  })

  await check('image decoding rejects oversized base64 before allocation', () => {
    assert.ok(MAX_IMAGE_BYTES > 0)
    const rejected = decodeDataUrl('data:image/png;base64,' + 'A'.repeat(100), { maxBytes: 10 })
    assert.equal(rejected, undefined)
  })

  await check('image decoding rejects malformed base64 but accepts wrapped valid data', () => {
    assert.equal(decodeDataUrl('data:image/png;base64,not@@base64'), undefined)
    assert.equal(decodeDataUrl('data:image/png;base64,abcd='), undefined)
    assert.equal(decodeDataUrl('data:image/png;base64, aW1h\nZ2U=')?.bytes.toString(), 'image')
    assert.equal(decodeDataUrl('data:IMAGE/PNG;charset=UTF-8;BASE64, aW1hZ2U=')?.mediaType, 'image/png')
    assert.equal(decodeDataUrl('data:text/plain;base64,aW1hZ2U='), undefined)
  })

  await check('malformed image-only prompts remain visible with an explicit placeholder', () => {
    const ts = now.toISOString()
    const built = buildRecords([{ records: [
      { type: 'session_meta', timestamp: ts, ordinal: 0, payload: { id: 'bad-image', cwd: '/tmp/bad-image' } },
      { type: 'response_item', timestamp: ts, ordinal: 1, payload: {
        type: 'message', role: 'user', content: [
          { type: 'input_image', image_url: 'data:image/png;base64,not@@base64' },
        ],
      } },
    ] }], 'bad-image')
    const user = built.records.find((event) => event.type === 'user/message')
    assert.ok(user)
    assert.match(user.data.content[0].text, /image omitted.*invalid/i)
    assert.equal(built.stats.imagesSkipped, 1)
  })

  await check('in-progress tool statuses are not misreported as failures', () => {
    assert.equal(itemFailed({ status: 'in_progress' }), false)
    assert.equal(itemFailed({ status: 'in-progress' }), false)
    assert.equal(itemFailed({ status: 'running' }), false)
    assert.equal(itemFailed({ status: 'failed' }), true)
  })

  await check('failure status aliases are normalized consistently', () => {
    assert.equal(itemFailed({ status: 'timed-out' }), true)
    assert.equal(itemFailed({ status: 'TIME OUT' }), true)
    assert.equal(outputIsError({ status: 'timed-out' }), true)
    assert.equal(outputIsError({ result: { status: 'in progress' } }), false)
  })

  await check('image generation accepts structured b64_json results', () => {
    const image = generatedImageOf({ result: { b64_json: onePixelPng } })
    assert.equal(image?.mediaType, 'image/png')
    assert.equal(image?.bytes.length > 0, true)
    const conversations = [{ segments: [{ records: [{
      type: 'response_item',
      payload: { type: 'imageGeneration', result: { b64Json: onePixelPng } },
    }] }] }]
    assert.equal(collectImages(conversations).size, 1)
  })

  await check('telemetry user images are admitted before synthetic message recovery', () => {
    const convo = { segments: [{ records: [{
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: { content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + onePixelPng }] },
      },
    }] }] }
    assert.equal(collectImages([convo]).size, 1)
  })

  await check('image-only telemetry prompts survive fallback recovery', async () => {
    const out = join(root, 'scratch-telemetry-image-only')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [telemetryImageOnlyId],
      saveImages: async (inputs) => inputs.map(() => ({
        attachmentId: 'sha256:telemetry-image-only', mediaType: 'image/png', width: 1, height: 1, bytes: 68,
      })),
    })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const users = events.filter((event) => event.type === 'user/message')
    assert.equal(users.length, 1)
    assert.ok(users[0].data.content.some((block) => block.type === 'image'))
    const listed = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const row = listed.rows.find((entry) => entry.sessionId === telemetryImageOnlyId)
    assert.equal(row?.prompt, '[image]')
    assert.equal(row?.prompts, 1)
  })

  await check('image-only prompts stay visible when the attachment store is unavailable', async () => {
    const out = join(root, 'scratch-telemetry-image-no-store')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [telemetryImageOnlyId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const user = events.find((event) => event.type === 'user/message')
    assert.ok(user)
    assert.match(user.data.content[0].text, /image omitted.*sha256:/i)
    assert.equal(imported.results[0].stats.imagesSkipped, 1)
  })

  await check('nested item_completed user prompts survive fallback recovery', async () => {
    const out = join(root, 'scratch-nested-telemetry-user')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [nestedTelemetryUserId],
      saveImages: async (inputs) => inputs.map(() => ({
        attachmentId: 'sha256:nested-telemetry-user', mediaType: 'image/png', width: 1, height: 1, bytes: 68,
      })),
    })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const users = events.filter((event) => event.type === 'user/message')
    assert.equal(users.length, 1)
    assert.match(JSON.stringify(users[0]), /nested telemetry prompt/)
    assert.ok(users[0].data.content.some((block) => block.type === 'image'))
  })

  await check('nested item_completed assistant messages recover once and mirror normal items', async () => {
    const out = join(root, 'scratch-assistant-telemetry')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [assistantTelemetryId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const assistants = events.filter((event) => event.type === 'assistant/message')
    assert.equal(assistants.length, 1)
    assert.match(JSON.stringify(assistants[0]), /assistant recovered from telemetry/)

    const ts = now.toISOString()
    const normal = {
      type: 'response_item', timestamp: ts, ordinal: 3,
      payload: {
        type: 'message', id: 'mirrored-assistant', role: 'assistant',
        content: [{ type: 'output_text', text: 'mirrored assistant' }],
        turn_id: 'mirrored-turn',
      },
    }
    const mirror = {
      type: 'event_msg', timestamp: ts, ordinal: 2,
      payload: {
        type: 'item_completed', turn_id: 'mirrored-turn', item: {
          type: 'AgentMessage', id: 'mirrored-assistant',
          content: [{ type: 'Text', text: 'mirrored assistant' }],
        },
      },
    }
    const built = buildRecords([{ records: [
      { type: 'session_meta', timestamp: ts, ordinal: 0, payload: { id: 'mirrored-session', cwd: '/tmp/mirrored' } },
      { type: 'event_msg', timestamp: ts, ordinal: 1, payload: { type: 'task_started', turn_id: 'mirrored-turn' } },
      mirror, normal,
    ] }], 'mirrored-session')
    assert.equal(built.records.filter((event) => event.type === 'assistant/message').length, 1)
  })

  await check('camelCase App Server items, inline tool blocks, and explicit titles survive', async () => {
    const out = join(root, 'scratch-rich-schema')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [richSchemaId],
      saveImages: async (inputs) => inputs.map((input) => ({
        attachmentId: 'sha256:rich-image', mediaType: input.mediaType,
        width: 1, height: 1, bytes: input.data.length,
      })),
    })
    assert.equal(imported.results.length, 1)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const user = events.find((event) => event.type === 'user/message')
    assert.match(JSON.stringify(user), /rich schema prompt/)
    assert.match(JSON.stringify(user), /sha256:rich-image/)
    const calls = events.filter((event) => event.type === 'tool/call')
    assert.ok(calls.some((event) => event.data.name === 'codex_command'))
    assert.ok(calls.some((event) => event.data.name === 'codex_file_change'))
    assert.ok(calls.some((event) => event.data.name === 'mcp__demo__lookup'))
    assert.ok(calls.some((event) => event.data.callId === 'rich-inline-1'))
    assert.ok(calls.some((event) => event.data.callId === 'rich-inline-1' && event.data.name === 'exec_command'))
    assert.ok(events.some((event) => JSON.stringify(event).includes('README updated')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('first thought')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('single string thought')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('final rich answer')))
    const title = events.find((event) => event.type === 'session/title')
    assert.equal(title.data.title, 'Rich schema title')
    assert.equal(title.data.source.kind, 'user')
    const listed = listConversations({
      sinceHours: Number.MAX_SAFE_INTEGER, codexRoot, project: '/tmp/rich-project',
    })
    const row = listed.rows.find((entry) => entry.sessionId === richSchemaId)
    assert.equal(row?.prompt, 'rich schema prompt')
    assert.equal(row?.prompts, 1)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('case and separator aliases plus replacementHistory remain importable', async () => {
    const out = join(root, 'scratch-alias-schema')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [aliasSchemaId] })
    assert.equal(imported.results.length, 1)
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.ok(events.some((event) => JSON.stringify(event).includes('uppercase user message')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('uppercase agent answer')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('alias command output')))
    assert.ok(events.some((event) => JSON.stringify(event).includes('uppercase history prompt')))
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('listing counts prompts recovered from compaction history', async () => {
    const out = join(root, 'scratch-compaction-history')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [compactionId] })
    assert.equal(imported.results[0].stats.historyMessages, 2)
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.type === 'user/message').length, 2)
    const listed = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const row = listed.rows.find((entry) => entry.sessionId === compactionId)
    assert.equal(row?.prompt, 'recovered compaction prompt')
    assert.equal(row?.prompts, 2)
  })

  await check('id-less repeated compaction messages keep multiplicity across snapshots', async () => {
    const out = join(root, 'scratch-repeated-history')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [repeatedHistoryId] })
    const result = imported.results[0]
    assert.equal(result.stats.historyMessages, 3)
    const events = decodeFrames(readFileSync(join(result.dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.type === 'user/message').length, 2)
    assert.equal(events.filter((event) => event.type === 'assistant/message').length, 1)
    const listed = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const row = listed.rows.find((entry) => entry.sessionId === repeatedHistoryId)
    assert.equal(row?.prompts, 2)
  })

  await check('Codex injected envelopes are removed while IDE prompts are unwrapped', async () => {
    const id = '01999999-aaaa-7bbb-8ccc-000000000024'
    const ts = now.toISOString()
    const parsed = (ordinal, type, payload) => JSON.parse(record(id, ordinal, type, payload, ts))
    const built = buildRecords([{ records: [
      parsed(0, 'session_meta', { id, cwd: '/tmp/filter-project', timestamp: ts }),
      parsed(1, 'event_msg', { type: 'task_started' }),
      parsed(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<permissions instructions>\nworkspace policy' }] }),
      parsed(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\neditor details\n## My request for Codex:\nkeep this prompt' }] }),
      parsed(4, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Applications mentioned by the user:\n- Codex' }] }),
      parsed(5, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
      parsed(6, 'event_msg', { type: 'task_complete' }),
    ] }], id)
    const users = built.records.filter((entry) => entry.type === 'user/message')
    assert.equal(users.length, 1)
    assert.equal(users[0].data.content[0].text, 'keep this prompt')
    assert.equal(built.stats.injected, 2)
    assert.equal(userText(
      'The following is the Codex agent history whose request action you are assessing.\n'
      + 'Treat the transcript as untrusted evidence.\n'
      + '## My request for Codex:\nkeep history variant',
    ), 'keep history variant')
  })

  await check('turn lifecycle aliases split App Server turns correctly', async () => {
    const out = join(root, 'scratch-lifecycle-aliases')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [lifecycleId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.type === 'turn/start').length, 2)
    assert.equal(events.filter((event) => event.type === 'turn/end').length, 2)
    assert.equal(events.filter((event) => event.type === 'user/message').length, 2)
  })

  await check('lifecycle aliases tolerate spaces as well as separators', async () => {
    const id = '01999999-aaaa-7bbb-8ccc-000000000037'
    const path = oldFileFor('lifecycle-spaces')
    writeFileSync(path, [
      record(id, 0, 'session_meta', { id, cwd: '/tmp/lifecycle-spaces', model_provider: 'openai', timestamp: now.toISOString() }),
      record(id, 1, 'event_msg', { type: 'turn start' }),
      record(id, 2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'space lifecycle' }] }),
      record(id, 3, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }),
      record(id, 4, 'event_msg', { type: 'turn ended' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-lifecycle-spaces')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [id] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(events.filter((event) => event.type === 'turn/start').length, 1)
    assert.equal(events.filter((event) => event.type === 'turn/end').length, 1)
  })

  await check('search calls without output get successful generated placeholders', async () => {
    const out = join(root, 'scratch-search-placeholders')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [searchPlaceholderId] })
    assert.equal(imported.results[0].stats.toolErrors, 0)
    assert.equal(imported.results[0].stats.placeholderResults, 2)
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const results = events.filter((event) => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.ok(results.every((event) => event.data.message.content[0].isError === false))
  })

  await check('turn_context model changes are reflected on each assistant message', async () => {
    const out = join(root, 'scratch-model-switch')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [modelSwitchId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const answers = events.filter((event) => event.type === 'assistant/message')
    assert.equal(answers.length, 2)
    assert.equal(answers[0].data.message.source.model, 'gpt-a')
    assert.equal(answers[1].data.message.source.model, 'gpt-b')
  })

  await check('nested item completion events are correlated by item id', async () => {
    const out = join(root, 'scratch-nested-outcome')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [nestedOutcomeId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const result = events.find((event) => event.type === 'tool/result')
    assert.match(result.data.message.content[0].content[0].text, /nested completion output/)
    assert.equal(result.data.message.content[0].isError, false)
  })

  await check('image-generation calls remain balanced when Codex has no output item', async () => {
    const out = join(root, 'scratch-generated-image')
    const imported = await runImport({
      root: out, codexRoot, sessionIds: [generatedImageId],
      saveImages: async (inputs) => inputs.map((input) => ({
        attachmentId: 'sha256:generated-image', mediaType: input.mediaType,
        width: 1, height: 1, bytes: input.data.length,
      })),
    })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const call = events.find((event) => event.type === 'tool/call')
    const result = events.find((event) => event.type === 'tool/result')
    assert.equal(call.data.name, 'image_generation')
    assert.equal(result.data.message.content[0].isError, false)
    assert.match(result.data.message.content[0].content[0].text, /image(?:_generation| generated)/i)
    assert.ok(result.data.message.content[0].content.some((block) => block.type === 'image'))
  })

  await check('turn_context model and telemetry-only final messages are recovered', async () => {
    const out = join(root, 'scratch-telemetry-tail')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [telemetryId] })
    const events = decodeFrames(readFileSync(join(imported.results[0].dir, 'session.v3.jsonl.zstd')))
      .slice(1).join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const assistant = events.find((event) => event.type === 'assistant/message')
    assert.equal(assistant.data.message.source.model, 'gpt-5.5')
    assert.match(JSON.stringify(assistant), /Recovered from telemetry/)
  })

  await check('the iterator loads one conversation at a time', () => {
    const refs = collectConversationRefs(rollouts)
    const seen = [...iterateConversations(refs)]
    assert.equal(seen.length, 2)
    assert.equal(seen[0].segments[0].records[0].type, 'session_meta')
    assert.equal(seen[1].segments[0].records[0].type, 'session_meta')
  })

  await check('listing summarizes the fixture without changing its shape', () => {
    const result = listConversations({ sinceHours: 1, codexRoot })
    assert.equal(result.rollouts, 2)
    assert.equal(result.rows.length, 2)
    assert.equal(result.rows[0].prompt, 'first prompt')
  })

  await check('project root selection includes descendants', () => {
    assert.equal(projectMatches('/repo/project/file', '/'), true)
    assert.equal(projectMatches('/repo/project/file', '/repo/project'), true)
    assert.equal(projectMatches('/repo/project-other', '/repo/project'), false)
  })

  await check('listing survives a null metadata record', () => {
    const result = listConversations({ sinceHours: Number.MAX_SAFE_INTEGER, codexRoot })
    const row = result.rows.find((entry) => entry.sessionId === nullMetadataId)
    assert.equal(row?.cwd, '/tmp/null-metadata-project')
    assert.equal(row?.prompt, 'null metadata prompt')
  })

  await check('rollout discovery does not follow a symlinked root', () => {
    const link = join(root, 'codex-link')
    symlinkSync(codexRoot, link, 'dir')
    assert.deepEqual(findRollouts(1, link), [])
  })

  await check('the plugin honours a profile-specific sessions root', () => {
    const previous = process.env.DSH_TUI_SESSION_ROOT
    process.env.DSH_TUI_SESSION_ROOT = join(root, 'profile-sessions')
    try {
      assert.equal(sessionsRoot(), join(root, 'profile-sessions'))
    } finally {
      if (previous === undefined) delete process.env.DSH_TUI_SESSION_ROOT
      else process.env.DSH_TUI_SESSION_ROOT = previous
    }
  })

  await check('the platform temporary directory remains usable when it has an OS symlink ancestor', () => {
    // macOS exposes os.tmpdir() below /var, and /var is a protected alias to
    // /private/var. The safety guard must permit that OS-owned alias while
    // continuing to reject user-created symlink components.
    assert.doesNotThrow(() => assertSafeRoot(tmpdir(), 'temporary import root'))
  })

  await check('published sessions are attached to an available workspace registry', async () => {
    const workspaceDir = join(root, 'workspace-project')
    mkdirSync(workspaceDir, { recursive: true })
    const scratch = join(root, 'workspace-scratch')
    const sessionDir = join(scratch, 'project-key', 'session-workspace')
    const calls = []
    const workspace = { attachSession: async (id) => { calls.push(id) } }
    const registry = {
      resolveByPath: async () => undefined,
      create: async (path) => { assert.equal(path, workspaceDir); return workspace },
    }
    const grouped = await groupIntoWorkspaces({ get: (name) => name === 'workspaceRegistry' ? registry : undefined }, [
      { id: 'session-workspace', cwd: workspaceDir, dir: sessionDir },
    ], scratch, { installed: ['project-key/session-workspace'] })
    assert.equal(grouped.available, true)
    assert.equal(grouped.grouped, 1)
    assert.deepEqual(calls, ['session-workspace'])
    const skipped = await groupIntoWorkspaces({ get: () => registry }, [
      { id: 'refused-session', cwd: workspaceDir, dir: sessionDir },
    ], scratch, { installed: [], refreshed: [], unchanged: [] })
    assert.equal(skipped.grouped, 0)
  })

  await check('path encoding preserves astral UTF-16 code units like DSH', () => {
    assert.equal(encodeSegment('😀'), '~D83D~DE00')
    assert.equal(projectKey('/fixture/😀'), '--fixture-~D83D~DE00--')
    assert.throws(() => encodeSegment(''), /empty/i)
    assert.throws(() => projectKey(''), /empty/i)
  })

  await check('malformed metadata is normalized to a valid DSH header', () => {
    const built = buildRecords([{
      records: [{ type: 'session_meta', timestamp: '1960-01-01T00:00:00.000Z', payload: {
        cwd: 'relative/project', model_provider: '', model: '',
      } }],
    }], 'metadata-check')
    assert.equal(built.cwd.startsWith('/'), true)
    assert.equal(built.createdAt >= 0, true)
    assert.equal(built.provider, 'openai')
    assert.equal(built.model, 'codex')
  })

  await check('frame decoding consumes concatenated zstd frames exactly', () => {
    const first = zstdCompressSync(Buffer.from('one\n'))
    const second = zstdCompressSync(Buffer.from('two\n'))
    assert.deepEqual(decodeFrames(Buffer.concat([first, second])), ['one\n', 'two\n'])
  })

  await check('frame decoding ignores magic bytes inside compressed payloads', () => {
    const magicPayload = Buffer.alloc(1000, 0)
    Buffer.from('28b52ffd', 'hex').copy(magicPayload, 500)
    const frame = zstdCompressSync(magicPayload)
    assert.deepEqual(decodeFrames(frame), [magicPayload.toString('utf8')])
  })

  await check('installed-log hashing preserves UTF-8 split across zstd frames', async () => {
    const ts = now.toISOString()
    const built = buildRecords([{ records: [
      { type: 'session_meta', timestamp: ts, ordinal: 0, payload: { id: splitInstalledId, cwd: '/tmp/split-installed' } },
      { type: 'event_msg', timestamp: ts, ordinal: 1, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp: ts, ordinal: 2, payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: '跨帧字符片' }],
      } },
      { type: 'response_item', timestamp: ts, ordinal: 3, payload: {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已保留' }],
      } },
      { type: 'event_msg', timestamp: ts, ordinal: 4, payload: { type: 'task_complete' } },
    ] }], splitInstalledId)
    const out = join(root, 'split-installed-log')
    const dir = sessionDirFor(built, out)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const body = Buffer.from(sessionBody(built), 'utf8')
    const marker = Buffer.from('片', 'utf8')
    const cut = body.indexOf(marker) + 1
    assert.ok(cut > 0)
    const header = Buffer.from(`${JSON.stringify(built.records[0])}\n`, 'utf8')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
      zstdCompressSync(header),
      zstdCompressSync(body.subarray(0, cut)),
      zstdCompressSync(body.subarray(cut)),
    ]))
    const log = join(dir, 'session.v3.jsonl.zstd')
    assert.equal(readSessionLog(log).bodySha256, bodySha256(built))
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('tool verification rejects incomplete call bookkeeping', () => {
    const assistant = {
      type: 'assistant/message', seq: 1, data: { message: {
        content: [{ type: 'tool-call', id: 'declared-only', name: 'x', arguments: '{}' }],
      } },
    }
    assert.throws(() => assertToolCallPairing([assistant]), /no tool\/call event/i)
    const result = {
      type: 'tool/result', seq: 2, data: { message: {
        source: { callId: 'result-only' },
        content: [{ type: 'tool-result', toolCallId: 'result-only', content: [] }],
      } },
    }
    assert.throws(() => assertToolCallPairing([result]), /no assistant.*tool-call/i)
  })

  await check('image detection tolerates pretty-printed event JSON', () => {
    const path = join(root, 'pretty-image.jsonl.zstd')
    writeFileSync(path, Buffer.concat([
      zstdCompressSync(Buffer.from('{"type":"session"}\n')),
      zstdCompressSync(Buffer.from('{ "type": "user/message", "data": { "content": [{ "type": "image" }] } }\n')),
    ]))
    assert.equal(readSessionLog(path).hasImages, true)
  })

  await check('an untracked existing two-frame log is refused', async () => {
    const scratch = join(root, 'scratch')
    const live = join(root, 'live')
    const converted = await runImport({ root: scratch, codexRoot, sessionIds: [idA] })
    const result = converted.results[0]
    const key = relative(scratch, result.dir)
    mkdirSync(join(live, key), { recursive: true })
    cpSync(join(result.dir, 'session.v3.jsonl.zstd'), join(live, key, 'session.v3.jsonl.zstd'))
    // The live file has the same shape but no importer state record.
    rmSync(join(live, 'codex-import-state.json'), { force: true })
    const before = readFileSync(join(live, key, 'session.v3.jsonl.zstd'))
    const buckets = syncSessions(scratch, live, [result])
    assert.equal(buckets.refused.length, 1)
    assert.deepEqual(readFileSync(join(live, key, 'session.v3.jsonl.zstd')), before)
  })

  await check('a scoped sync preserves ownership records for other sessions', async () => {
    const scratchA = join(root, 'scratch-state-a')
    const scratchB = join(root, 'scratch-state-b')
    const live = join(root, 'live-state')
    const a = (await runImport({ root: scratchA, codexRoot, sessionIds: [idA] })).results[0]
    const b = (await runImport({ root: scratchB, codexRoot, sessionIds: [idB] })).results[0]
    syncSessions(scratchA, live, [a])
    syncSessions(scratchB, live, [b])
    const state = JSON.parse(readFileSync(join(live, '..', 'codex-import-state.json'), 'utf8'))
    assert.equal(Object.keys(state.sessions).length, 2)
  })

  await check('a stale ownership digest is refused rather than trusted', async () => {
    const scratch = join(root, 'scratch-stale-state')
    const live = join(root, 'live-stale-state')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    syncSessions(scratch, live, [result])
    const key = relative(scratch, result.dir)
    const statePath = join(live, '..', 'codex-import-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.sessions[key].bodySha256 = 'f'.repeat(64)
    writeFileSync(statePath, `${JSON.stringify(state)}\n`)
    const buckets = syncSessions(scratch, live, [result])
    assert.equal(buckets.unchanged.length, 0)
    assert.equal(buckets.refused.length, 1)
  })

  await check('dry runs do not write through the image store', async () => {
    writeRollout(fileFor(imageId, 'image'), imageId, 'image prompt', 'ok', true)
    let calls = 0
    const result = await runImport({
      root: join(root, 'scratch-dry'), codexRoot, sessionIds: [imageId], dryRun: true,
      saveImages: async () => { calls += 1; return [{ attachmentId: 'sha256:nope' }] },
    })
    assert.equal(result.results.length, 1)
    assert.equal(calls, 0)
  })

  await check('an aborted import stops before loading or writing a conversation', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runImport({ root: join(root, 'scratch-aborted'), codexRoot, sessionIds: [idA], signal: controller.signal }),
      (error) => error?.name === 'AbortError' || /aborted/i.test(String(error?.message)),
    )
    assert.equal(existsSync(join(root, 'scratch-aborted')), false)
  })

  await check('the composed command passes its attachment context to image imports', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const previousSessionRoot = process.env.DSH_TUI_SESSION_ROOT
    const pluginRoot = join(root, 'plugin-live')
    let command
    const ctx = {
      commands: {
        register: async (definition) => { command = definition },
      },
      attachments: {
        saveImages: async (inputs) => inputs.map((input) => ({
          attachmentId: 'sha256:test-image', mediaType: input.mediaType,
          width: 1, height: 1, bytes: input.data.length,
        })),
      },
    }
    ctx.effect = (generator) => {
      const iterator = generator()
      let step = iterator.next()
      while (!step.done) step = iterator.next(step.value)
    }
    process.env.CODEX_HOME = join(root, 'codex')
    process.env.DSH_TUI_SESSION_ROOT = pluginRoot
    try {
      const { apply } = await import('../lib/index.js')
      apply(ctx)
      assert.ok(command !== undefined)
      const response = await command.handler({ rawInput: `--session ${imageId}` })
      assert.equal(response.kind, 'success', response.text)
      assert.match(response.text, /image\(s\) attached/i)
      const projects = readdirSync(pluginRoot)
      assert.ok(projects.length > 0)
      assert.ok(existsSync(join(pluginRoot, projects[0])))
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousSessionRoot === undefined) delete process.env.DSH_TUI_SESSION_ROOT
      else process.env.DSH_TUI_SESSION_ROOT = previousSessionRoot
    }
  })

  await check('orphaned tool results are repaired into a resumable call pair', async () => {
    const orphanPath = fileFor(orphanId, 'orphan')
    writeFileSync(orphanPath, [
      record(orphanId, 0, 'session_meta', {
        session_id: orphanId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(orphanId, 1, 'event_msg', { type: 'task_started' }),
      record(orphanId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'orphan test' }],
      }),
      record(orphanId, 3, 'response_item', {
        type: 'function_call_output', call_id: 'missing-call', output: 'recovered output',
      }),
      record(orphanId, 4, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-orphan')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [orphanId] })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].stats.repairedTools, 1)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('tool calls without outputs receive a deterministic error result', async () => {
    const pendingPath = fileFor(pendingId, 'pending')
    writeFileSync(pendingPath, [
      record(pendingId, 0, 'session_meta', {
        session_id: pendingId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(pendingId, 1, 'event_msg', { type: 'task_started' }),
      record(pendingId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pending test' }],
      }),
      record(pendingId, 3, 'response_item', {
        type: 'function_call', call_id: 'never-returned', name: 'shell', arguments: '{}',
      }),
      record(pendingId, 4, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-pending')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [pendingId] })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].stats.repairedTools, 1)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('duplicate raw tool ids are renamed while both results stay paired', async () => {
    const out = join(root, 'scratch-duplicate-call-ids')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [duplicateCallId] })
    assert.equal(imported.results.length, 1)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const calls = events.filter((event) => event.type === 'tool/call')
    const results = events.filter((event) => event.type === 'tool/result')
    assert.equal(calls.length, 2)
    assert.equal(results.length, 2)
    assert.equal(new Set(calls.map((event) => event.data.callId)).size, 2)
    assert.deepEqual(results.map((event) => event.data.message.content[0].content[0].text), [
      'first result', 'second result',
    ])
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('duplicate raw ids keep distinct telemetry completions paired', async () => {
    const out = join(root, 'scratch-duplicate-event-call-ids')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [duplicateEventCallId] })
    assert.equal(imported.results.length, 1)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const results = events.filter((event) => event.type === 'tool/result')
    assert.deepEqual(results.map((event) => event.data.message.content[0].content[0].text), [
      'first event result', 'second event result',
    ])
    assert.ok(results.every((event) => event.data.message.content[0].isError === false))
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('local shell items and command failures survive conversion', async () => {
    const shellPath = fileFor(shellId, 'local-shell')
    writeFileSync(shellPath, [
      record(shellId, 0, 'session_meta', {
        session_id: shellId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(shellId, 1, 'event_msg', { type: 'task_started' }),
      record(shellId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shell test' }],
      }),
      record(shellId, 3, 'response_item', {
        type: 'local_shell_call', call_id: 'shell-call-1', status: 'completed',
        action: { type: 'exec', command: ['echo', 'hello'], working_directory: '/tmp/project' },
      }),
      record(shellId, 4, 'event_msg', {
        type: 'exec_command_end', call_id: 'shell-call-1', status: 'completed', exit_code: 2,
        stderr: 'command failed',
      }),
      record(shellId, 5, 'response_item', {
        type: 'local_shell_call_output', id: 'shell-output-1', call_id: 'shell-call-1',
        output: 'command failed', status: 'completed',
      }),
      record(shellId, 6, 'response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
      }),
      record(shellId, 7, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-local-shell')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [shellId] })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].stats.toolErrors, 1)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const call = events.find((event) => event.type === 'tool/call')
    const result = events.find((event) => event.type === 'tool/result')
    assert.equal(call.data.name, 'local_shell')
    assert.match(call.data.arguments, /echo/)
    assert.equal(result.data.message.content[0].isError, true)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('completion events recover output when the response item is missing', async () => {
    const eventOnlyPath = fileFor(eventOnlyId, 'event-only')
    writeFileSync(eventOnlyPath, [
      record(eventOnlyId, 0, 'session_meta', {
        session_id: eventOnlyId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(eventOnlyId, 1, 'event_msg', { type: 'task_started' }),
      record(eventOnlyId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'event output test' }],
      }),
      record(eventOnlyId, 3, 'response_item', {
        type: 'function_call', call_id: 'event-call-1', name: 'exec_command', arguments: '{}',
      }),
      record(eventOnlyId, 4, 'event_msg', {
        type: 'exec_command_end', call_id: 'event-call-1', status: 'completed', exit_code: 7,
        stdout: 'captured from completion event',
      }),
      record(eventOnlyId, 5, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-event-only')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [eventOnlyId] })
    assert.equal(imported.results.length, 1)
    assert.equal(imported.results[0].stats.toolErrors, 1)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const result = events.find((event) => event.type === 'tool/result')
    assert.match(result.data.message.content[0].content[0].text, /captured from completion event/)
    assert.equal(result.data.message.content[0].isError, true)
  })

  await check('structured tool output exposes content and exit failures', async () => {
    const structuredId = '01999999-aaaa-7bbb-8ccc-000000000008'
    const structuredPath = fileFor(structuredId, 'structured-output')
    writeFileSync(structuredPath, [
      record(structuredId, 0, 'session_meta', {
        session_id: structuredId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(structuredId, 1, 'event_msg', { type: 'task_started' }),
      record(structuredId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'structured output test' }],
      }),
      record(structuredId, 3, 'response_item', {
        type: 'function_call', call_id: 'structured-call-1', name: 'exec_command', arguments: '{}',
      }),
      record(structuredId, 4, 'response_item', {
        type: 'function_call_output', call_id: 'structured-call-1',
        output: JSON.stringify({ content: 'structured failure', metadata: { exit_code: 3 } }),
      }),
      record(structuredId, 5, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-structured-output')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [structuredId] })
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const result = events.find((event) => event.type === 'tool/result')
    assert.match(result.data.message.content[0].content[0].text, /structured failure/)
    assert.equal(result.data.message.content[0].isError, true)
  })

  await check('primitive tool outputs remain readable strings', () => {
    assert.equal(outputText({ output: 0 }), '0')
    assert.equal(outputText({ output: false }), 'false')
    assert.equal(outputText({ output: { result: 7 } }), '{"result":7}')
  })

  await check('failed structured shell output is marked without an exit code', async () => {
    const statusId = '01999999-aaaa-7bbb-8ccc-000000000009'
    const statusPath = fileFor(statusId, 'failed-status')
    writeFileSync(statusPath, [
      record(statusId, 0, 'session_meta', {
        session_id: statusId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(statusId, 1, 'event_msg', { type: 'task_started' }),
      record(statusId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'failed status test' }],
      }),
      record(statusId, 3, 'response_item', {
        type: 'local_shell_call', call_id: 'failed-status-call',
        action: { type: 'exec', command: ['false'], working_directory: '/tmp/project' },
      }),
      record(statusId, 4, 'response_item', {
        type: 'local_shell_call_output', call_id: 'failed-status-call', status: 'failed',
        output: 'shell reported failure',
      }),
      record(statusId, 5, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-failed-status')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [statusId] })
    assert.equal(imported.results[0].stats.toolErrors, 1)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('completion events retain earlier output fragments', async () => {
    const mergeId = '01999999-aaaa-7bbb-8ccc-000000000010'
    const mergePath = fileFor(mergeId, 'merged-output')
    writeFileSync(mergePath, [
      record(mergeId, 0, 'session_meta', {
        session_id: mergeId, cwd: '/tmp/project', model_provider: 'openai', model: 'codex',
        timestamp: now.toISOString(),
      }),
      record(mergeId, 1, 'event_msg', { type: 'task_started' }),
      record(mergeId, 2, 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'merge output test' }],
      }),
      record(mergeId, 3, 'response_item', {
        type: 'function_call', call_id: 'merge-call', name: 'exec_command', arguments: '{}',
      }),
      record(mergeId, 4, 'event_msg', {
        type: 'exec_command_output', call_id: 'merge-call', stdout: 'partial output', status: 'in_progress',
      }),
      record(mergeId, 5, 'event_msg', {
        type: 'exec_command_end', call_id: 'merge-call', status: 'completed', exit_code: 0,
      }),
      record(mergeId, 6, 'event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n')
    const out = join(root, 'scratch-merged-output')
    const imported = await runImport({ root: out, codexRoot, sessionIds: [mergeId] })
    assert.equal(imported.results[0].stats.toolErrors, 0)
    const log = join(imported.results[0].dir, 'session.v3.jsonl.zstd')
    const events = decodeFrames(readFileSync(log)).slice(1).join('').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
    const result = events.find((event) => event.type === 'tool/result')
    assert.match(result.data.message.content[0].content[0].text, /partial output/)
    const verified = await verifyPaths([out], { quiet: true })
    assert.equal(verified.failed, 0, verified.failures.map((f) => f.message).join('; '))
  })

  await check('a malformed existing log is refused instead of aborting the batch', async () => {
    const scratch = join(root, 'scratch-malformed')
    const live = join(root, 'live-malformed')
    const converted = await runImport({ root: scratch, codexRoot, sessionIds: [idA] })
    const result = converted.results[0]
    const key = relative(scratch, result.dir)
    mkdirSync(join(live, key), { recursive: true })
    writeFileSync(join(live, key, 'session.v3.jsonl.zstd'), Buffer.from('not zstd'))
    const buckets = syncSessions(scratch, live, [result])
    assert.equal(buckets.refused.length, 1)
    assert.match(buckets.refused[0].reason, /unreadable|malformed|log/i)
  })

  await check('a broken scratch session is isolated from valid siblings', async () => {
    const scratch = join(root, 'scratch-broken-source')
    const live = join(root, 'live-broken-source')
    const converted = await runImport({ root: scratch, codexRoot, sessionIds: [idA] })
    const valid = converted.results[0]
    const brokenKey = 'broken-project/broken-session'
    mkdirSync(join(scratch, brokenKey), { recursive: true })
    const broken = { dir: join(scratch, brokenKey), bodySha256: '0'.repeat(64), stats: {} }
    const buckets = syncSessions(scratch, live, [valid, broken])
    assert.ok(buckets.installed.includes(relative(scratch, valid.dir)))
    assert.ok(buckets.refused.some((entry) => entry.key === brokenKey))
    assert.ok(existsSync(join(live, relative(scratch, valid.dir), 'session.v3.jsonl.zstd')))
  })

  await check('symlinked destination ancestors are refused', async () => {
    const scratch = join(root, 'scratch-symlink')
    const live = join(root, 'live-symlink')
    const outside = join(root, 'outside-symlink')
    const converted = await runImport({ root: scratch, codexRoot, sessionIds: [idA] })
    const result = converted.results[0]
    const key = relative(scratch, result.dir)
    const project = key.split('/')[0]
    mkdirSync(outside, { recursive: true })
    mkdirSync(live, { recursive: true })
    symlinkSync(outside, join(live, project), 'dir')
    const buckets = syncSessions(scratch, live, [result])
    assert.equal(buckets.installed.length, 0)
    assert.equal(buckets.refused.length, 1)
    assert.match(buckets.refused[0].reason, /symbolic|symlink|regular/i)
    assert.equal(existsSync(join(outside, key.slice(project.length + 1))), false)
  })

  await check('a symlink used as the scratch root is refused', async () => {
    const scratchReal = join(root, 'scratch-real-root')
    const scratchLink = join(root, 'scratch-root-link')
    const live = join(root, 'live-scratch-root-link')
    const result = (await runImport({ root: scratchReal, codexRoot, sessionIds: [idA] })).results[0]
    symlinkSync(scratchReal, scratchLink, 'dir')
    assert.throws(() => syncSessions(scratchLink, live, [result]), /scratch root|symbolic|regular directory/i)
  })

  await check('dot-dot paths cannot hide a symlink component', () => {
    const real = join(root, 'dotdot-real')
    const link = join(root, 'dotdot-link')
    mkdirSync(real, { recursive: true, mode: 0o700 })
    symlinkSync(real, link, 'dir')
    assert.throws(
      () => assertSafeRoot(`${link}/../dotdot-target`, 'output root'),
      /symbolic-link component|symbolic-link ancestor/i,
    )
  })

  await check('a nonexistent output root below a symlink is refused before writing', async () => {
    const parentReal = join(root, 'output-parent-real')
    const parentLink = join(root, 'output-parent-link')
    mkdirSync(parentReal, { recursive: true, mode: 0o700 })
    symlinkSync(parentReal, parentLink, 'dir')
    const output = join(parentLink, 'new-output')
    await assert.rejects(
      runImport({ root: output, codexRoot, sessionIds: [idA] }),
      /output root.*symbolic-link (?:ancestor|component)/i,
    )
    assert.deepEqual(readdirSync(parentReal), [])
  })

  await check('a symlink used as the sessions root is refused', async () => {
    const scratch = join(root, 'scratch-root-symlink')
    const real = join(root, 'live-root-real')
    const link = join(root, 'live-root-link')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link, 'dir')
    assert.throws(() => syncSessions(scratch, link, [result]), /regular directory|symbolic/i)
  })

  await check('a disappearing scratch root becomes a refusal instead of an exception', () => {
    const scratch = join(root, 'scratch-disappearing')
    const live = join(root, 'live-disappearing')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    mkdirSync(live, { recursive: true, mode: 0o700 })
    rmSync(scratch, { recursive: true, force: true })
    const buckets = syncSessions(scratch, live, [])
    assert.equal(buckets.installed.length, 0)
    assert.equal(buckets.refused.length, 1)
    assert.equal(buckets.refused[0].key, '<scratch>')
  })

  await check('an output log symlink is rejected without touching its target', async () => {
    const out = join(root, 'output-log-symlink')
    const dir = join(out, projectKey('/tmp/project'), encodeSegment(`session-${idA}`))
    const outside = join(root, 'output-log-symlink-target.txt')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(outside, 'outside stays unchanged\n')
    symlinkSync(outside, join(dir, 'session.v3.jsonl.zstd'), 'file')
    await assert.rejects(
      runImport({ root: out, codexRoot, sessionIds: [idA] }),
      /output session log.*symbolic link/i,
    )
    assert.equal(readFileSync(outside, 'utf8'), 'outside stays unchanged\n')
    assert.equal(readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0)
  })

  await check('a symlinked manifest archive directory is refused before metadata writes', () => {
    const parent = join(root, 'manifest-symlink-parent')
    const live = join(parent, 'live-manifest-symlink')
    const outside = join(parent, 'manifest-symlink-target')
    mkdirSync(live, { recursive: true, mode: 0o700 })
    mkdirSync(outside, { recursive: true, mode: 0o700 })
    const link = join(parent, 'codex-import-manifests')
    symlinkSync(outside, link, 'dir')
    try {
      assert.throws(() => writeManifest(live, {
        installed: ['project/session'], backups: [], newDigests: {}, runId: 'safe-run-id',
      }), /symbolic-link ancestor|metadata (?:path|directory)|regular directory/i)
      assert.deepEqual(readdirSync(outside), [])
    } finally {
      // Node 24 requires recursive=true when removing a directory symlink;
      // the flag still removes the link itself without traversing its target.
      rmSync(link, { recursive: true, force: true })
    }
  })

  await check('a symlinked ownership state is refused before session publication', async () => {
    const scratch = join(root, 'scratch-state-file-link')
    const parent = join(root, 'state-file-link-parent')
    const live = join(parent, 'live-state-file-link')
    const outside = join(parent, 'state-file-link-target.json')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    mkdirSync(live, { recursive: true, mode: 0o700 })
    writeFileSync(outside, '{"version":1,"sessions":{}}\n', { mode: 0o600 })
    const link = statePath(live)
    symlinkSync(outside, link, 'file')
    const buckets = syncSessions(scratch, live, [result])
    assert.equal(buckets.installed.length, 0)
    assert.equal(buckets.refused.length, 1)
    assert.match(buckets.refused[0].reason, /metadata target.*symbolic link/i)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readFileSync(outside, 'utf8'), '{"version":1,"sessions":{}}\n')
    assert.equal(existsSync(join(live, relative(scratch, result.dir), 'session.v3.jsonl.zstd')), false)
  })

  await check('a symlinked latest manifest is preserved and never replaced', () => {
    const parent = join(root, 'latest-manifest-file-link-parent')
    const live = join(parent, 'live-latest-manifest-file-link')
    const outside = join(parent, 'latest-manifest-file-link-target.json')
    mkdirSync(live, { recursive: true, mode: 0o700 })
    writeFileSync(outside, '{"keep":true}\n', { mode: 0o600 })
    const link = manifestPath(live)
    symlinkSync(outside, link, 'file')
    assert.throws(
      () => writeManifest(live, {
        installed: ['project/session'], backups: [], newDigests: {}, runId: 'safe-run-id',
      }),
      /metadata target.*symbolic link/i,
    )
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readFileSync(outside, 'utf8'), '{"keep":true}\n')
  })

  await check('a symlinked rollback manifest is rejected without reading its target', () => {
    const parent = join(root, 'rollback-manifest-file-link-parent')
    const live = join(parent, 'live-rollback-manifest-file-link')
    const outside = join(parent, 'rollback-manifest-file-link-target.json')
    mkdirSync(live, { recursive: true, mode: 0o700 })
    writeFileSync(outside, JSON.stringify({ version: 2, liveRoot: live, remove: [], restore: [] }) + '\n')
    const link = join(parent, 'manifest-link.json')
    symlinkSync(outside, link, 'file')
    assert.throws(() => rollbackManifest(link), /rollback manifest.*symbolic link/i)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
  })

  await check('a symlinked rollback backup root is refused', async () => {
    const scratchOld = join(root, 'scratch-backup-link-old')
    const scratchNew = join(root, 'scratch-backup-link-new')
    const live = join(root, 'live-backup-link')
    const outside = join(root, 'outside-backup-link')
    const old = (await runImport({ root: scratchOld, codexRoot, sessionIds: [idA] })).results[0]
    const source = fileFor(idA)
    const original = readFileSync(source, 'utf8')
    const changed = original.replace('first prompt', 'backup link prompt')
    writeFileSync(source, changed)
    const fresh = (await runImport({ root: scratchNew, codexRoot, sessionIds: [idA] })).results[0]
    syncSessions(scratchOld, live, [old])
    mkdirSync(outside, { recursive: true })
    const backupLink = join(root, 'codex-import-backups')
    symlinkSync(outside, backupLink, 'dir')
    try {
      const key = relative(scratchOld, old.dir)
      const before = readFileSync(join(live, key, 'session.v3.jsonl.zstd'))
      const buckets = syncSessions(scratchNew, live, [fresh])
      assert.equal(buckets.refreshed.length, 0)
      assert.equal(buckets.refused.length, 1)
      assert.match(buckets.refused[0].reason, /metadata directory.*symbolic link/i)
      assert.deepEqual(readFileSync(join(live, key, 'session.v3.jsonl.zstd')), before)
      assert.equal(readdirSync(outside).length, 0)
    } finally {
      // Keep the cleanup portable across Node 22 and Node 24: recursive=true
      // removes the directory link, never the directory it points at.
      rmSync(backupLink, { recursive: true, force: true })
      writeFileSync(source, original)
    }
  })

  await check('rollback restores refreshed content and leaves unchanged sessions alone', async () => {
    const scratchOld = join(root, 'scratch-old')
    const scratchNew = join(root, 'scratch-new')
    const live = join(root, 'live-rollback')
    const old = (await runImport({ root: scratchOld, codexRoot, sessionIds: [idA] })).results[0]
    // Make a distinct fresh conversion without relying on random IDs.
    const source = fileFor(idA)
    const original = readFileSync(source, 'utf8')
    const text = original.replace(/(?:first|backup link) prompt/g, 'changed prompt')
    writeFileSync(source, text)
    try {
      const fresh = (await runImport({ root: scratchNew, codexRoot, sessionIds: [idA] })).results[0]
      syncSessions(scratchOld, live, [old])
      const buckets = syncSessions(scratchNew, live, [fresh])
      const manifest = writeManifest(live, buckets)
      assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).remove.length, 0)
      assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).restore.length, 1)
      const report = rollbackManifest(manifest)
      assert.equal(report.restored, 1)
      assert.equal(readSessionLog(join(live, relative(scratchOld, old.dir), 'session.v3.jsonl.zstd')).bodySha256, old.bodySha256)
      assert.equal(JSON.parse(readFileSync(join(live, '..', 'codex-import-state.json'), 'utf8')).sessions[relative(scratchOld, old.dir)].bodySha256, old.bodySha256)
      assert.equal(statSync(manifest).mode & 0o777, 0o600)
    } finally {
      writeFileSync(source, original)
    }
  })

  await check('rollback skips an installed session that changed after import', async () => {
    const scratch = join(root, 'scratch-rollback-skip')
    const live = join(root, 'live-rollback-skip')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    const buckets = syncSessions(scratch, live, [result])
    const manifest = writeManifest(live, buckets)
    const key = relative(scratch, result.dir)
    // Simulate a user continuing the imported session by replacing its log.
    writeFileSync(join(live, key, 'session.v3.jsonl.zstd'), Buffer.concat([
      readFileSync(join(live, key, 'session.v3.jsonl.zstd')),
      zstdCompressSync(Buffer.from('{"type":"step/start"}\n')),
    ]))
    const report = rollbackManifest(manifest)
    assert.equal(report.removed, 0)
    assert.equal(report.skipped, 1)
    assert.ok(statSync(join(live, key, 'session.v3.jsonl.zstd')))
  })

  await check('legacy rollback leaves a continued session intact', async () => {
    const scratch = join(root, 'scratch-legacy-rollback')
    const live = join(root, 'live-legacy-rollback')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    syncSessions(scratch, live, [result])
    const key = relative(scratch, result.dir)
    writeFileSync(legacyManifestPath(live), `${join(live, key)}\n`)
    const log = join(live, key, 'session.v3.jsonl.zstd')
    writeFileSync(log, Buffer.concat([readFileSync(log), zstdCompressSync(Buffer.from('{"type":"step/start"}\n'))]))
    const report = rollbackManifest(legacyManifestPath(live))
    assert.equal(report.removed, 0)
    assert.equal(report.skipped, 1)
    assert.ok(statSync(log))
  })

  await check('legacy rollback cannot authorize a path outside its manifest directory', async () => {
    const scratch = join(root, 'scratch-legacy-security')
    const outside = join(root, 'legacy-outside', 'project', 'session')
    const manifestDir = join(root, 'legacy-manifest')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    mkdirSync(outside, { recursive: true })
    mkdirSync(manifestDir, { recursive: true })
    cpSync(join(result.dir, 'session.v3.jsonl.zstd'), join(outside, 'session.v3.jsonl.zstd'))
    const manifest = join(manifestDir, 'codex-import-manifest.txt')
    writeFileSync(manifest, `${outside}\n`)
    const report = rollbackManifest(manifest)
    assert.equal(report.removed, 0)
    assert.equal(report.skipped, 1)
    assert.ok(statSync(join(outside, 'session.v3.jsonl.zstd')))
  })

  await check('a v2 rollback manifest without digests is rejected', async () => {
    const scratch = join(root, 'scratch-manifest-schema')
    const live = join(root, 'live-manifest-schema')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idA] })).results[0]
    const buckets = syncSessions(scratch, live, [result])
    const key = relative(scratch, result.dir)
    const bad = join(root, 'manifest-without-digest.json')
    writeFileSync(bad, `${JSON.stringify({ version: 2, liveRoot: live, remove: [{ key }], restore: [] })}\n`)
    assert.throws(() => rollbackManifest(bad), /body digest/i)
    assert.ok(statSync(join(live, key, 'session.v3.jsonl.zstd')))
    assert.equal(buckets.installed.length, 1)
  })

  await check('each sync keeps an immutable rollback manifest', async () => {
    const scratch = join(root, 'scratch-manifest-history')
    const live = join(root, 'live-manifest-history')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idB] })).results[0]
    const firstBuckets = syncSessions(scratch, live, [result])
    const firstManifest = writeManifest(live, firstBuckets)
    const firstDetail = JSON.parse(readFileSync(firstManifest, 'utf8'))
    const archiveBeforeRollback = readFileSync(firstManifest)
    const secondBuckets = syncSessions(scratch, live, [result])
    const secondManifest = writeManifest(live, secondBuckets)
    // A no-op run must preserve the earlier undo record instead of replacing
    // it with an empty manifest. The immutable archive remains the useful path.
    assert.equal(secondManifest, firstManifest)
    assert.equal(JSON.parse(readFileSync(firstManifest, 'utf8')).remove.length, 1)
    assert.deepEqual(readFileSync(firstManifest), archiveBeforeRollback)
    const report = rollbackManifest(firstManifest)
    assert.equal(report.removed, 1)
    assert.deepEqual(readFileSync(firstManifest), archiveBeforeRollback)
    const rollbackResult = rollbackResultPath(live, firstDetail.runId)
    assert.equal(JSON.parse(readFileSync(rollbackResult, 'utf8')).result.removed, 1)
  })

  await check('verification does not follow a symlinked selection root', () => {
    const real = join(root, 'verify-real')
    const link = join(root, 'verify-link')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link, 'dir')
    assert.deepEqual(findLogs(link), [])
  })

  await check('the CLI can apply the generated rollback manifest', async () => {
    const scratch = join(root, 'scratch-cli-rollback')
    const live = join(root, 'live-cli-rollback')
    const result = (await runImport({ root: scratch, codexRoot, sessionIds: [idB] })).results[0]
    const buckets = syncSessions(scratch, live, [result])
    const manifest = writeManifest(live, buckets)
    const child = spawnSync(process.execPath, [
      'bin/import-codex.mjs', 'rollback', '--manifest', manifest,
    ], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /removed\s+1/i)
    const installedLog = join(live, relative(scratch, result.dir), 'session.v3.jsonl.zstd')
    assert.equal(statSync(installedLog, { throwIfNoEntry: false }), undefined)
  })

  await check('the CLI validates options and honours profile session roots', () => {
    const cli = (args, env = {}) => spawnSync(process.execPath, ['bin/import-codex.mjs', ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    })
    const help = cli(['--help'])
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /--codex-root/)
    assert.match(help.stdout, /--limit/)
    assert.match(help.stdout, /--archived/)
    assert.match(help.stdout, /rollback/)

    const home = join(root, 'cli-home')
    const profileRoot = join(root, 'profile-root')
    const dry = cli([
      'sync', '--codex-root', codexRoot, '--dsh-home', home,
      '--session', idA, '--dry-run',
    ])
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /all verified/i)
    assert.equal(existsSync(join(home, 'sessions')), false)

    const live = cli([
      'sync', '--codex-root', codexRoot, '--dsh-home', home,
      '--session', idA,
    ], { DSH_TUI_SESSION_ROOT: profileRoot })
    assert.equal(live.status, 0, live.stderr)
    assert.ok(existsSync(profileRoot))
    assert.equal(existsSync(join(home, 'sessions')), false)

    const missing = cli(['list', '--since-hours'])
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /requires a value|since-hours/i)

    const invalidLimit = cli(['list', '--limit', '0'])
    assert.equal(invalidLimit.status, 2)
    assert.match(invalidLimit.stderr, /limit.*positive/i)
  })
} finally {
  cleanTestRoot(root)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
