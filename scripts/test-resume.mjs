#!/usr/bin/env node
/**
 * Resume one converted session through the harness's ACP profile.
 *
 * Usage: node scripts/test-resume.mjs <sessions-root> [session-id]
 *
 * Unlike the shipped ACP smoke test this does not build a fixture: it points an
 * isolated DSH home at a real sessions root so a large, real conversion can be
 * proven loadable by the same code path a user reaches with /resume.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { TEST_DSH_BIN } from './test-env.mjs'

const [sessionsRoot, wantedId, homeArgument] = process.argv.slice(2)
if (sessionsRoot === undefined) throw new Error('usage: test-resume.mjs <sessions-root> [session-id] [dsh-home]')

// The profile resolves its store from DSH_HOME, so the caller's home has to be
// reused rather than replaced: a fresh temporary home would list nothing.
const home = homeArgument ?? process.env.DSH_HOME
if (home === undefined) throw new Error('pass a DSH home or set DSH_HOME')
mkdirSync(home, { recursive: true, mode: 0o700 })

const child = spawn(TEST_DSH_BIN, ['--profile', 'acp'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TUI_SESSION_ROOT: sessionsRoot,
  },
})

let buffer = ''
let stderr = ''
const pending = new Map()
let nextId = 1
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr += chunk })
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim().length === 0) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const entry = pending.get(message.id)
    if (entry === undefined) continue
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'ACP error'))
    else entry.resolve(message.result)
  }
})

const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`timeout waiting for ${method}`))
  }, 120_000)
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolve(value) },
    reject: (error) => { clearTimeout(timer); reject(error) },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

try {
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'resume-check', version: '1' },
    clientCapabilities: {},
  })
  const listed = await request('session/list', {})
  console.log(`listed ${listed.sessions.length} session(s)`)
  const target = wantedId === undefined
    ? listed.sessions[0]
    : listed.sessions.find((entry) => entry.sessionId === wantedId)
  if (target === undefined) throw new Error(`session ${wantedId} is not listed`)
  console.log(`resuming ${target.sessionId} (${target.cwd})`)
  const resumed = await request('session/resume', {
    sessionId: target.sessionId,
    cwd: target.cwd,
    mcpServers: [],
  })
  console.log(`resumed: ${JSON.stringify(resumed.configOptions?.map((option) => option.id) ?? [])}`)
  await request('session/close', { sessionId: target.sessionId })
  console.log('RESUME OK')
} catch (error) {
  console.log(`RESUME FAILED: ${error.message}`)
  if (stderr.trim().length > 0) console.log(`stderr tail:\n${stderr.trim().slice(-2_000)}`)
  process.exitCode = 1
} finally {
  child.kill('SIGTERM')
}
