/**
 * Small, realistic Codex rollout corpus shared by the repository-local tests.
 * It deliberately includes a two-segment tool round, a long tool result, and a
 * valid PNG data URL so conversion, attachment admission, and reconciliation
 * are exercised without reading the user's ~/.codex history.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestRoot, cleanTestRoot } from './test-env.mjs'

const IMAGE_DATA_URL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const pad = (value) => String(value).padStart(2, '0')
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

const line = (timestamp, ordinal, type, payload) => JSON.stringify({ timestamp, ordinal, type, payload })

/**
 * Create an isolated Codex corpus and return its paths/ids.
 *
 * The returned `cleanup()` removes the tree unless `keep` is passed. Every path
 * is below this repository's `.test-work` directory.
 */
export function createCodexFixture(label = 'codex-fixture') {
  const root = makeTestRoot(label)
  const codexRoot = join(root, 'codex', 'sessions')
  mkdirSync(codexRoot, { recursive: true, mode: 0o700 })
  const base = new Date(Date.now() - 2_000)
  const primaryId = '01999999-aaaa-7bbb-8ccc-000000000101'
  const secondaryId = '01999999-aaaa-7bbb-8ccc-000000000102'
  const imageId = primaryId
  const longOutput = 'tool-output-' + 'x'.repeat(12_000)
  const meta = (id, timestamp) => line(timestamp, 0, 'session_meta', {
    session_id: id,
    cwd: '/repo/dsh-codex-import-fixture',
    model_provider: 'openai',
    model: 'codex-mini',
    timestamp,
  })
  const writeSegment = (id, date, suffix, records) => {
    const path = join(codexRoot, `rollout-${stamp(date)}-${suffix}.jsonl`)
    writeFileSync(path, `${records.join('\n')}\n`, { mode: 0o600 })
    return path
  }

  const firstTs = base.toISOString()
  const secondDate = new Date(base.getTime() + 1_000)
  const secondTs = secondDate.toISOString()
  const primarySegments = [
    writeSegment(primaryId, base, 'fixture-a', [
      meta(primaryId, firstTs),
      line(firstTs, 1, 'event_msg', { type: 'task_started' }),
      line(firstTs, 2, 'response_item', {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'fixture prompt with an image' },
          { type: 'input_image', image_url: IMAGE_DATA_URL },
        ],
      }),
      line(firstTs, 3, 'response_item', {
        type: 'function_call', call_id: 'fixture-call-1', name: 'shell', arguments: '{"cmd":"printf fixture"}',
      }),
    ]),
    writeSegment(primaryId, secondDate, 'fixture-b', [
      meta(primaryId, secondTs),
      line(secondTs, 4, 'response_item', {
        type: 'function_call_output', call_id: 'fixture-call-1', output: longOutput,
      }),
      line(secondTs, 5, 'response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture complete' }],
      }),
      line(secondTs, 6, 'event_msg', { type: 'task_complete' }),
    ]),
  ]

  const secondaryPath = writeSegment(secondaryId, new Date(base.getTime() + 2_000), 'fixture-c', [
    meta(secondaryId, new Date(base.getTime() + 2_000).toISOString()),
    line(new Date(base.getTime() + 2_000).toISOString(), 1, 'event_msg', { type: 'task_started' }),
    line(new Date(base.getTime() + 2_000).toISOString(), 2, 'response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second fixture prompt' }],
    }),
    line(new Date(base.getTime() + 2_000).toISOString(), 3, 'response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second fixture answer' }],
    }),
    line(new Date(base.getTime() + 2_000).toISOString(), 4, 'event_msg', { type: 'task_complete' }),
  ])

  return {
    root,
    codexRoot,
    primaryId,
    secondaryId,
    imageId,
    primarySegments,
    secondaryPath,
    longOutput,
    imageDataUrl: IMAGE_DATA_URL,
    cleanup: (keep = false) => cleanTestRoot(root, keep),
  }
}
