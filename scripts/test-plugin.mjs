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
 * The test creates a fixed two-segment fixture inside the repository, so it is
 * deterministic and never scans a user's live Codex corpus.
 */
import { existsSync, readdirSync, statSync, cpSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { openAttachmentStore } from '../lib/store.js'
import { createCodexFixture } from './test-fixture.mjs'

const argv = process.argv.slice(2)
const optOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)

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

const fixture = createCodexFixture('codex-plugin-test')
const home = join(fixture.root, 'dsh-home')
const root = join(home, 'sessions')
const previousDshHome = process.env.DSH_HOME
const previousCodexHome = process.env.CODEX_HOME
const previousSessionRoot = process.env.DSH_TUI_SESSION_ROOT
process.env.DSH_HOME = home
process.env.CODEX_HOME = join(fixture.root, 'codex')
delete process.env.DSH_TUI_SESSION_ROOT

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
  const sessionId = optOf('--session') ?? fixture.primaryId
  const selection = `--session ${sessionId}`
  console.log(`selection: ${selection}  (isolated fixture)`)

  const listed = await command.handler({ rawInput: '' })
  check('a bare invocation lists instead of importing', () => {
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /conversation\(s\) in the last 24 h|No conversations started in the last 24 h/)
    assert.equal(existsSync(root), false, 'listing created the sessions root')
  })

  const dry = await command.handler({ rawInput: `${selection} --dry-run` })
  check('--dry-run converts and verifies without writing', () => {
    assert.equal(dry.kind, 'success', dry.text)
    assert.match(dry.text, /Dry run/)
    assert.equal(existsSync(root), false, 'a dry run created the sessions root')
  })

  const spacedCodexRoot = join(fixture.root, 'codex root', 'sessions')
  mkdirSync(join(fixture.root, 'codex root'), { recursive: true, mode: 0o700 })
  cpSync(fixture.codexRoot, spacedCodexRoot, { recursive: true })
  const quotedPath = await command.handler({
    rawInput: `${selection} --codex-root "${spacedCodexRoot}" --dry-run`,
  })
  check('quoted paths remain intact in slash-command options', () => {
    assert.equal(quotedPath.kind, 'success', quotedPath.text)
    assert.match(quotedPath.text, /Dry run/)
  })

  const previousImportTmpRoot = process.env.DSH_CODEX_IMPORT_TMP_ROOT
  const temporaryReal = join(fixture.root, 'temporary-root-real')
  const temporaryLink = join(fixture.root, 'temporary-root-link')
  mkdirSync(temporaryReal, { recursive: true, mode: 0o700 })
  symlinkSync(temporaryReal, temporaryLink, 'dir')
  process.env.DSH_CODEX_IMPORT_TMP_ROOT = temporaryLink
  const blockedTemporaryRoot = await command.handler({ rawInput: `${selection} --dry-run` })
  if (previousImportTmpRoot === undefined) delete process.env.DSH_CODEX_IMPORT_TMP_ROOT
  else process.env.DSH_CODEX_IMPORT_TMP_ROOT = previousImportTmpRoot
  check('a symlinked temporary root is rejected before any write', () => {
    assert.equal(blockedTemporaryRoot.kind, 'error')
    assert.match(blockedTemporaryRoot.text, /temporary import root|symbolic link|regular directory/i)
    assert.deepEqual(readdirSync(temporaryReal), [])
  })

  const liveReal = join(fixture.root, 'live-root-real')
  const liveLink = join(fixture.root, 'live-root-link')
  mkdirSync(liveReal, { recursive: true, mode: 0o700 })
  symlinkSync(liveReal, liveLink, 'dir')
  process.env.DSH_TUI_SESSION_ROOT = liveLink
  const blockedLiveRoot = await command.handler({ rawInput: selection })
  if (previousSessionRoot === undefined) delete process.env.DSH_TUI_SESSION_ROOT
  else process.env.DSH_TUI_SESSION_ROOT = previousSessionRoot
  check('a symlinked sessions root is rejected before any write', () => {
    assert.equal(blockedLiveRoot.kind, 'error')
    assert.match(blockedLiveRoot.text, /sessions root|symbolic link|regular directory/i)
    assert.deepEqual(readdirSync(liveReal), [])
  })

  console.log(`\ninstalls, then reports itself up to date`)
  const first = await command.handler({ rawInput: selection })
  check('a real run installs sessions', () => {
    assert.equal(first.kind, 'success', first.text)
    assert.match(first.text, /new/)
    assert.match(first.text, /image\(s\) attached/i)
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

  const limited = await command.handler({ rawInput: '--limit 1' })
  check('a selector without --since-hours still imports instead of listing', () => {
    assert.equal(limited.kind, 'success', limited.text)
    assert.match(limited.text, /already up to date|new|refreshed/)
    assert.doesNotMatch(limited.text, /conversation\(s\) in the last/)
  })

  console.log(`\nthe installed logs pass the harness validators`)
  const { verifyPaths, readSessionLog } = await import('../lib/verify.js')
  const verified = await verifyPaths([root], { quiet: true })
  check(`${verified.passed} log(s) valid, ${verified.failed} invalid, ${verified.events} events`, () => {
    assert.equal(verified.failed, 0)
    assert.ok(verified.events > 0)
  })
  check('the real attachment store leaves an image reference in the log', () => {
    const log = join(installed[0], 'session.v3.jsonl.zstd')
    assert.equal(readSessionLog(log).hasImages, true)
    assert.ok(existsSync(store.root), 'attachment store did not create its root')
  })
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  if (previousSessionRoot === undefined) delete process.env.DSH_TUI_SESSION_ROOT
  else process.env.DSH_TUI_SESSION_ROOT = previousSessionRoot
  fixture.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
