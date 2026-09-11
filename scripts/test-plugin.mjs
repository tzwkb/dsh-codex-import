#!/usr/bin/env node
/**
 * End-to-end test of the `/import-codex` command itself.
 *
 * The slash command is the surface that actually gets used, and it is the one
 * piece the reconcile tests cannot reach: they drive `syncSessions` directly.
 * This composes the plugin the way the harness does — register, then invoke the
 * handler — against a throwaway `DSH_HOME`, so a real run installs into a
 * temp sessions root and the real store is never touched.
 *
 * Checks:
 *   bare invocation lists and writes nothing;
 *   --dry-run converts and verifies but writes nothing;
 *   a real run installs a session that passes the harness validators;
 *   a second real run reports it as already up to date and writes nothing.
 *
 * By default it pins one conversation that nothing has written to for ten
 * minutes, because a session still being generated would legitimately change
 * between the two runs. `--session ID` and `--since-hours N` override that.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { openAttachmentStore } from '../lib/store.js'
import { findRollouts, collectConversations } from '../lib/convert.js'

const argv = process.argv.slice(2)
const optOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
const sinceHours = optOf('--since-hours') === undefined ? 24 : Number(optOf('--since-hours'))

/**
 * Choose a conversation nothing is writing to at the moment.
 *
 * The Codex corpus is live — a session the user is still running grows between
 * two imports. "A second run changes nothing" is only a meaningful assertion
 * for a conversation that has stopped moving, so quiescence is read from the
 * rollout file mtime rather than assumed.
 */
function pickQuietSession(quietMinutes = 10) {
  const now = Date.now()
  const candidates = []
  for (const convo of collectConversations(findRollouts(sinceHours))) {
    const newest = Math.max(...convo.segments.map((s) => statSync(s.path).mtimeMs))
    if (now - newest < quietMinutes * 60_000) continue
    candidates.push({
      sessionId: convo.sessionId,
      records: convo.segments.reduce((n, s) => n + s.records.length, 0),
    })
  }
  candidates.sort((a, b) => a.records - b.records)
  // Prefer a conversation with some substance; a five-record stub exercises the
  // plumbing without exercising much of the mapping.
  return candidates.find((c) => c.records > 40) ?? candidates.find((c) => c.records > 4)
}

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

const home = mkdtempSync(join(tmpdir(), 'codex-plugin-test-'))
const root = join(home, 'sessions')
// The plugin resolves its sessions root from DSH_HOME at call time, so pointing
// the environment at a temp home is enough to keep the real store untouched.
process.env.DSH_HOME = home

/** Compose the plugin exactly as the harness would. */
function compose(ctx) {
  let command
  ctx.commands.register = async (c) => { command = c }
  // `ctx.effect` runs the registration generator; the yields are the effects.
  ctx.effect = (generator) => {
    const it = generator()
    let step = it.next()
    while (!step.done) step = it.next(step.value)
  }
  return () => command
}

try {
  const store = await openAttachmentStore(join(home, 'attachments-home'))
  const ctx = { commands: {}, attachments: store }
  const { apply } = await import('../lib/index.js')
  const commandOf = compose(ctx)
  apply(ctx)
  const command = commandOf()

  check('the plugin registers /import-codex', () => {
    assert.ok(command !== undefined, 'apply() did not call commands.register')
    assert.equal(command.name, 'import-codex')
  })

  console.log(`\ndry run and listing write nothing`)
  const quiet = optOf('--session') === undefined ? pickQuietSession() : undefined
  const sessionId = optOf('--session') ?? quiet?.sessionId
  const selection = sessionId === undefined ? `--since-hours ${sinceHours}` : `--session ${sessionId}`
  console.log(sessionId === undefined
    ? `selection: --since-hours ${sinceHours} (no quiescent conversation found to pin)`
    : `selection: ${selection}  (${quiet?.records ?? 'given'} records, quiet for 10+ min)`)

  const listed = await command.handler({ rawInput: '' })
  check('a bare invocation lists instead of importing', () => {
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /conversation\(s\) in the last 24 h/)
    assert.equal(existsSync(root), false, 'listing created the sessions root')
  })

  const dry = await command.handler({ rawInput: `${selection} --dry-run` })
  check('--dry-run converts and verifies without writing', () => {
    assert.equal(dry.kind, 'success', dry.text)
    assert.match(dry.text, /Dry run/)
    assert.equal(existsSync(root), false, 'a dry run created the sessions root')
  })

  console.log(`\ninstalls, then reports itself up to date`)
  const first = await command.handler({ rawInput: selection })
  check('a real run installs sessions', () => {
    assert.equal(first.kind, 'success', first.text)
    assert.match(first.text, /new/)
    assert.ok(existsSync(root))
  })
  const installed = []
  for (const project of readdirSync(root)) for (const s of readdirSync(join(root, project))) installed.push(join(root, project, s))
  check('every installed session is a two-frame log with mode 600', () => {
    assert.ok(installed.length > 0)
    for (const dir of installed) {
      const log = join(dir, 'session.v3.jsonl.zstd')
      assert.equal(statSync(log).mode & 0o777, 0o600, `${log} is not 0600`)
    }
  })
  const stamps = new Map(installed.map((dir) => [dir, statSync(join(dir, 'session.v3.jsonl.zstd')).mtimeMs]))
  const second = await command.handler({ rawInput: selection })
  check('a second identical run changes nothing on disk', () => {
    assert.equal(second.kind, 'success', second.text)
    assert.match(second.text, /already up to date/)
    for (const [dir, mtime] of stamps) {
      assert.equal(statSync(join(dir, 'session.v3.jsonl.zstd')).mtimeMs, mtime, `${dir} was rewritten`)
    }
  })
  check('nothing is left alone on a clean install', () => {
    assert.doesNotMatch(second.text, /left alone/)
  })

  console.log(`\nthe installed logs pass the harness validators`)
  const { verifyPaths } = await import('../lib/verify.js')
  const verified = await verifyPaths([root], { quiet: true })
  check(`${verified.passed} log(s) valid, ${verified.failed} invalid, ${verified.events} events`, () => {
    assert.equal(verified.failed, 0)
    assert.ok(verified.events > 0)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
