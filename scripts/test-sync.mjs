#!/usr/bin/env node
/**
 * Behavioural test for the incremental reconcile.
 *
 * Every case here is a promise the importer makes to a sessions root that a
 * human is actively using, so each one is checked against real files rather
 * than a mock:
 *
 *   determinism  two conversions of one conversation are byte-identical, which
 *                is what makes "already up to date" a meaningful answer at all;
 *   install      a first sync publishes the session;
 *   unchanged    a second sync of unchanged input writes nothing at all;
 *   refresh      content that really differs is replaced in place, keeping the
 *                session id, its directory and its sibling files;
 *   refuse       a session continued inside DSH is never rewritten;
 *   refuse       a log rewritten by something else is never rewritten;
 *   force        the refusal is an explicit, opt-in override;
 *   images       a conversion that could not reach the attachment store does
 *                not overwrite a log that holds images.
 *
 * Usage: node scripts/test-sync.mjs [--session ID] [--keep]
 */
import { mkdirSync, cpSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import assert from 'node:assert/strict'
import {
  runImport, sessionBody, serializeSession,
} from '../lib/convert.js'
import { syncSessions, writeManifest, readState, statePath, manifestPath } from '../lib/sync.js'
import { verifyPaths, readSessionLog } from '../lib/verify.js'
import { createCodexFixture } from './test-fixture.mjs'

const argv = process.argv.slice(2)
const optOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)

let passed = 0
let failed = 0
const section = (title) => console.log(`\n${title}`)
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

const fixture = createCodexFixture('codex-sync-test')
const root = fixture.root
const codexRoot = fixture.codexRoot
const convert = async (name, maxToolOutput) => {
  const out = join(root, `scratch-${name}`)
  mkdirSync(out, { recursive: true })
  const { results } = await runImport({ root: out, codexRoot, sessionIds: [sessionId], maxToolOutput })
  assert.equal(results.length, 1, `expected exactly one conversation for ${sessionId}`)
  return { out, result: results[0] }
}
const live = (name) => {
  const dir = join(root, `live-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const logOf = (liveRoot, rel) => join(liveRoot, rel, 'session.v3.jsonl.zstd')
const keyOf = (result, scratchRoot) => relative(scratchRoot, result.dir)

let sessionId = optOf('--session') ?? fixture.primaryId
const imageSessionId = fixture.imageId

try {
  console.log(`session under test:  ${sessionId}`)
  console.log(`image-bearing:       ${imageSessionId}`)
  console.log(`scratch:             ${root}`)

  section('conversion is deterministic')
  const full = await convert('full', 0)
  const again = await convert('again', 0)
  const key = keyOf(full.result, full.out)
  check('same conversation converts to identical bytes', () => {
    assert.equal(
      readFileSync(logOf(full.out, key)).toString('base64'),
      readFileSync(logOf(again.out, key)).toString('base64'),
    )
  })
  check('a second conversion yields the same body digest', () => {
    assert.equal(full.result.bodySha256, again.result.bodySha256)
  })

  section('first sync installs, second sync writes nothing')
  const liveA = live('a')
  const first = syncSessions(full.out, liveA, [full.result])
  check('the session is installed', () => {
    assert.equal(first.installed.length, 1)
    assert.equal(first.refreshed.length + first.unchanged.length + first.refused.length, 0)
  })
  const installedBefore = readFileSync(logOf(liveA, key))
  const mtimeBefore = statSync(logOf(liveA, key)).mtimeMs
  syncSessions(full.out, liveA, [full.result])
  const second = syncSessions(full.out, liveA, [full.result])
  check('re-syncing identical input reports unchanged', () => {
    assert.equal(second.unchanged.length, 1)
    assert.equal(second.installed.length + second.refreshed.length + second.refused.length, 0)
  })
  check('re-syncing identical input does not rewrite the file', () => {
    assert.equal(statSync(logOf(liveA, key)).mtimeMs, mtimeBefore)
    assert.deepEqual(readFileSync(logOf(liveA, key)), installedBefore)
  })
  check('a no-op sync does not rewrite ownership metadata', () => {
    const metadata = statSync(statePath(liveA))
    const third = syncSessions(full.out, liveA, [full.result])
    assert.equal(third.unchanged.length, 1)
    const after = statSync(statePath(liveA))
    assert.equal(after.ino, metadata.ino)
    assert.equal(after.mtimeMs, metadata.mtimeMs)
  })
  check('the rollback manifest names only sessions created by this run', () => {
    writeFileSync(join(liveA, key, 'sibling.txt'), 'keep me\n')
    const manifest = writeManifest(liveA, first)
    const detail = JSON.parse(readFileSync(manifest, 'utf8'))
    assert.deepEqual(detail.remove.map((entry) => entry.key), [key])
    assert.deepEqual(detail.restore, [])
    assert.equal(detail.version, 2)
  })
  check('a no-op manifest call preserves the previous rollback record', () => {
    const latest = manifestPath(liveA)
    const before = readFileSync(latest)
    const metadata = statSync(latest)
    const noOp = syncSessions(full.out, liveA, [full.result])
    writeManifest(liveA, noOp)
    const after = statSync(latest)
    assert.deepEqual(readFileSync(latest), before)
    assert.equal(after.ino, metadata.ino)
    assert.equal(after.mtimeMs, metadata.mtimeMs)
  })

  section('changed content is refreshed in place')
  const clipped = await convert('clipped', 100)
  check('the clipped conversion really is different', () => {
    assert.ok(clipped.result.stats.truncated > 0, 'expected the 100-char limit to truncate something')
    assert.notEqual(clipped.result.bodySha256, full.result.bodySha256)
  })
  const liveB = live('b')
  syncSessions(clipped.out, liveB, [clipped.result])
  const refresh = syncSessions(full.out, liveB, [full.result])
  check('differing content refreshes rather than duplicating', () => {
    assert.equal(refresh.refreshed.length, 1)
    assert.deepEqual(readdirSync(join(liveB, key)).sort(), ['session.v3.jsonl.zstd'])
  })
  check('the refreshed log matches the fresh conversion exactly', () => {
    assert.equal(readSessionLog(logOf(liveB, key)).bodySha256, full.result.bodySha256)
  })
  check('the refreshed log is well-formed: two frames, mode 600', () => {
    assert.equal(readSessionLog(logOf(liveB, key)).frames, 2)
    assert.equal(statSync(logOf(liveB, key)).mode & 0o777, 0o600)
  })
  check('the state file records the refreshed digest', () => {
    assert.equal(readState(liveB).sessions[key].bodySha256, full.result.bodySha256)
  })

  section('a session continued inside DSH is never rewritten')
  const liveC = live('c')
  syncSessions(full.out, liveC, [full.result])
  // The harness appends one frame per event batch; mimic one extra batch.
  writeFileSync(logOf(liveC, key), Buffer.concat([
    readFileSync(logOf(liveC, key)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'step/start', seq: 9999, data: {} })}\n`)),
  ]))
  const continued = readFileSync(logOf(liveC, key))
  const refuseContinued = syncSessions(clipped.out, liveC, [clipped.result])
  check('the continuation is detected and refused', () => {
    assert.equal(refuseContinued.refused.length, 1)
    assert.match(refuseContinued.refused[0].reason, /continued in DSH/)
  })
  check('the continued log is left byte-identical', () => {
    assert.deepEqual(readFileSync(logOf(liveC, key)), continued)
  })

  section('a log rewritten by something else is never rewritten')
  const liveD = live('d')
  syncSessions(full.out, liveD, [full.result])
  cpSync(logOf(clipped.out, key), logOf(liveD, key))
  const foreign = readFileSync(logOf(liveD, key))
  const refuseForeign = syncSessions(full.out, liveD, [full.result])
  check('an unrecognised two-frame log is refused', () => {
    assert.equal(refuseForeign.refused.length, 1)
    assert.match(refuseForeign.refused[0].reason, /rewritten after the import/)
  })
  check('the foreign log is left byte-identical', () => {
    assert.deepEqual(readFileSync(logOf(liveD, key)), foreign)
  })
  const forced = syncSessions(full.out, liveD, [full.result], true)
  check('--force overrides the refusal', () => {
    assert.equal(forced.refreshed.length, 1)
    assert.equal(readSessionLog(logOf(liveD, key)).bodySha256, full.result.bodySha256)
  })

  section('a conversion without the attachment store cannot drop images')
  if (imageSessionId === undefined) {
    console.log('  SKIP  no image-bearing conversation is available in the last 24 h')
  } else {
    const out = join(root, 'scratch-images')
    const { results } = await runImport({ root: out, codexRoot, sessionIds: [imageSessionId] })
    const [imgResult] = results
    check('the store-less conversion skips its images', () => {
      assert.ok(imgResult.stats.imagesSkipped > 0, 'expected images to be skipped without a store')
    })
    const ikey = keyOf(imgResult, out)
    const liveE = live('e')
    mkdirSync(join(liveE, ikey), { recursive: true })
    // Stand in for what a store-backed import would have installed: the same
    // log, plus the image block the store-less conversion cannot reproduce.
    const body = sessionBody({
      records: [
        { type: 'session' },
        { type: 'user/message', seq: 0, data: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:x' } }] } },
      ],
    })
    writeFileSync(logOf(liveE, ikey), serializeSession({ records: [{ type: 'session', version: 3, id: 'session-x' }] }, body))
    const before = readFileSync(logOf(liveE, ikey))
    const refuseImages = syncSessions(out, liveE, [imgResult])
    check('a store-less conversion is refused rather than dropping images', () => {
      assert.equal(refuseImages.refused.length, 1)
      assert.match(refuseImages.refused[0].reason, /attachment store/)
    })
    check('the image-bearing log is left byte-identical', () => {
      assert.deepEqual(readFileSync(logOf(liveE, ikey)), before)
    })
  }

  section('every published log still passes the harness validators')
  const verified = await verifyPaths([liveA, liveB, liveD])
  check(`${verified.passed} log(s) valid, ${verified.failed} invalid, ${verified.events} events`, () => {
    assert.equal(verified.failed, 0)
  })
} finally {
  if (argv.includes('--keep')) console.log(`\nkept: ${root}`)
  else fixture.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
