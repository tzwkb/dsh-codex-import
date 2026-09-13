#!/usr/bin/env node
/**
 * End-to-end restore check through DSH's ACP profile.
 *
 * The test deliberately stops after `session/resume`: sending a model prompt
 * would require a live provider credential and would turn a local regression
 * test into a network call. Resume itself exercises the persistence and agent
 * construction path that a user reaches before the first new prompt.
 */
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { runImport } from '../lib/convert.js'
import { createCodexFixture } from './test-fixture.mjs'
import { makeTestRoot, cleanTestRoot, TEST_DSH_BIN } from './test-env.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}\n        ${String(error.message).split('\n').join('\n        ')}`)
  }
}

const fixture = createCodexFixture('codex-acp-test')
const work = makeTestRoot('acp-home')
const home = join(work, 'dsh')
let child
const pending = new Map()
let nextRequestId = 1
let output = ''

const rejectPending = (error) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
}

const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextRequestId++
  const timer = setTimeout(() => {
    if (!pending.has(id)) return
    pending.delete(id)
    reject(new Error(`ACP request timed out: ${method}`))
  }, 5_000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
    if (error == null || !pending.has(id)) return
    clearTimeout(timer)
    pending.delete(id)
    reject(error)
  })
})

const stopChild = async () => {
  if (child === undefined) return
  rejectPending(new Error('ACP process exited before replying'))
  let closed = false
  const onClose = () => { closed = true }
  child.once('close', onClose)
  if (!child.killed) child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!closed) child.kill('SIGKILL')
      resolve()
    }, 2_000)
    child.once('close', () => {
      clearTimeout(timer)
      closed = true
      resolve()
    })
  })
  child = undefined
}

try {
  await runImport({
    root: join(home, 'sessions'),
    codexRoot: fixture.codexRoot,
    sessionIds: [fixture.primaryId],
  })
  child = spawn(TEST_DSH_BIN, ['--profile', 'acp'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      CODEX_HOME: join(work, 'codex-empty'),
      DSH_TUI_SESSION_ROOT: join(home, 'sessions'),
    },
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  child.stdout.on('data', (chunk) => {
    output += chunk
    let newline
    while ((newline = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, newline)
      output = output.slice(newline + 1)
      if (line.trim().length === 0) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.id === undefined || !pending.has(message.id)) continue
      const current = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(current.timer)
      if (message.error !== undefined) current.reject(new Error(message.error.message ?? 'ACP error'))
      else current.resolve(message.result)
    }
  })
  child.on('close', (code) => rejectPending(new Error(`ACP process closed (${code})`)))

  const initialized = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'dsh-codex-import-test', version: '1' },
    clientCapabilities: {},
  })
  check('ACP initializes against the isolated DSH runtime', () => {
    assert.equal(typeof initialized.protocolVersion, 'number')
  })

  const listed = await request('session/list', {})
  check('ACP lists the imported session from the isolated home', () => {
    assert.equal(listed.sessions.length, 1)
    assert.equal(listed.sessions[0].cwd, '/repo/dsh-codex-import-fixture')
  })

  const sessionId = listed.sessions[0].sessionId
  const resumed = await request('session/resume', {
    sessionId,
    cwd: listed.sessions[0].cwd,
    mcpServers: [],
  })
  check('ACP resumes the imported session and composes config', () => {
    assert.ok(Array.isArray(resumed.configOptions))
  })

  await request('session/close', { sessionId })
  check('ACP closes the resumed session cleanly', () => {})
} catch (error) {
  failed += 1
  console.log(`  FAIL  ACP end-to-end flow\n        ${String(error.message).split('\n').join('\n        ')}`)
} finally {
  await stopChild()
  fixture.cleanup()
  cleanTestRoot(work)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
