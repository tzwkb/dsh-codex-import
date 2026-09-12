/**
 * Reconcile a fresh conversion against a live sessions root.
 *
 * The importer writes a compact two-frame log. A running DSH session appends
 * frames as it continues, so replacing an existing file blindly can erase
 * turns that were created after the import. This module owns the small amount
 * of state needed to distinguish an importer-owned file from a live session,
 * and records enough information to undo a refresh safely.
 *
 * @module dsh-codex-import/sync
 */
import {
  cpSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync,
  renameSync, chmodSync, rmSync, lstatSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { readSessionLog } from './verify.js'

const STATE_VERSION = 1
const MANIFEST_VERSION = 2

/** Parent directory that holds importer metadata for a sessions root. */
function metadataRoot(liveRoot) {
  return dirname(resolve(liveRoot))
}

/** Record of what this importer last wrote, per installed session. */
export function statePath(liveRoot) {
  return join(metadataRoot(liveRoot), 'codex-import-state.json')
}

/** Detailed, transactional rollback manifest for the most recent sync. */
export function manifestPath(liveRoot) {
  return join(metadataRoot(liveRoot), 'codex-import-manifest.json')
}

/** Immutable manifest for one sync run, retained for later targeted rollback. */
export function archiveManifestPath(liveRoot, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid manifest run id')
  return join(metadataRoot(liveRoot), 'codex-import-manifests', `${id}.json`)
}

/** Result record for a rollback; kept separate so archived manifests stay immutable. */
export function rollbackResultPath(liveRoot, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid rollback result id')
  return join(metadataRoot(liveRoot), 'codex-import-rollback-results', `${id}.json`)
}

/** Compatibility path retained for users of the pre-0.2 text manifest. */
export function legacyManifestPath(liveRoot) {
  return join(metadataRoot(liveRoot), 'codex-import-manifest.txt')
}

function writeAtomic(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  try {
    writeFileSync(temp, contents, { mode })
    chmodSync(temp, mode)
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

function writeState(liveRoot, state) {
  writeAtomic(statePath(liveRoot), `${JSON.stringify(state, null, 2)}\n`)
}

export function readState(liveRoot) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(liveRoot), 'utf8'))
    if (parsed?.version === STATE_VERSION && typeof parsed.sessions === 'object'
      && parsed.sessions !== null && !Array.isArray(parsed.sessions)) return parsed
  } catch {
    // Missing or unreadable state is intentionally treated as no ownership.
    // A caller can opt into replacing such a file with --force.
  }
  return { version: STATE_VERSION, sessions: {} }
}

function readLinkSafe(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

function isSymlink(path) {
  return readLinkSafe(path)?.isSymbolicLink() === true
}

/** Detect a symlink in the destination's existing ancestor chain. */
function hasSymlinkAncestor(root, target) {
  const base = resolve(root)
  let current = resolve(target)
  while (current !== base && current.startsWith(`${base}${sep}`)) {
    if (isSymlink(current)) return true
    current = dirname(current)
  }
  return isSymlink(base)
}

/** Keep all filesystem operations below the selected sessions root. */
function pathForKey(root, key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) throw new Error('invalid session key')
  const parts = key.split(/[\\/]/)
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`invalid session key: ${key}`)
  }
  const basePath = resolve(root)
  const candidate = resolve(basePath, key)
  const base = `${basePath}${sep}`
  if (!candidate.startsWith(base)) throw new Error(`session key escapes sessions root: ${key}`)
  return candidate
}

/** Replace one installed log in place, so sibling files in the dir survive. */
function replaceLog(from, to) {
  const source = join(from, 'session.v3.jsonl.zstd')
  const sourceStat = readLinkSafe(source)
  if (sourceStat === undefined || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error('the conversion output has no regular session log')
  }
  const target = join(to, 'session.v3.jsonl.zstd')
  const staged = join(to, `.session.v3.jsonl.zstd.tmp-${process.pid}-${Date.now()}-${randomUUID()}`)
  try {
    cpSync(source, staged, { force: false, errorOnExist: true })
    chmodSync(staged, 0o600)
    renameSync(staged, target)
  } finally {
    rmSync(staged, { force: true })
  }
}

/** Publish a new session through a sibling staging directory. */
function installSession(from, to) {
  const source = join(from, 'session.v3.jsonl.zstd')
  const sourceStat = readLinkSafe(source)
  if (sourceStat === undefined || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error('the conversion output has no regular session log')
  }
  const parent = dirname(to)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const staged = join(parent, `.codex-session-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(staged, { recursive: true, mode: 0o700 })
    const stagedLog = join(staged, 'session.v3.jsonl.zstd')
    cpSync(source, stagedLog, { force: false, errorOnExist: true })
    const stagedStat = readLinkSafe(stagedLog)
    if (stagedStat === undefined || stagedStat.isSymbolicLink() || !stagedStat.isFile()) {
      throw new Error('the conversion output has no regular session log')
    }
    chmodSync(stagedLog, 0o600)
    if (existsSync(to) || isSymlink(to)) throw new Error('the destination appeared during installation')
    renameSync(staged, to)
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

function safeReadLog(path) {
  try {
    return readSessionLog(path)
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/** Reject a sessions root that is a file, a symlink, or reached through one. */
function assertSafeRoot(root) {
  const base = resolve(root)
  const stat = readLinkSafe(base)
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`the sessions root is not a regular directory: ${root}`)
  }
  // Ancestors above the selected root may be platform aliases (for example
  // macOS's /tmp -> /private/tmp). The path checks below constrain every
  // session target relative to this root; only the root itself must be real.
}

function refusal(key, reason) {
  return { key, reason }
}

function runId() {
  return `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17)}-${process.pid}-${randomUUID().slice(0, 8)}`
}

function backupLog(liveRoot, key, id) {
  const source = pathForKey(liveRoot, key)
  const sourceLog = join(source, 'session.v3.jsonl.zstd')
  const sourceStat = readLinkSafe(sourceLog)
  if (sourceStat === undefined || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error('the installed session log is not a regular file')
  }
  const backupRoot = join(metadataRoot(liveRoot), 'codex-import-backups')
  const backup = join(backupRoot, id, key, 'session.v3.jsonl.zstd')
  if (hasSymlinkAncestor(metadataRoot(liveRoot), backup)) {
    throw new Error('the rollback backup path contains a symbolic-link ancestor')
  }
  mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
  cpSync(sourceLog, backup)
  chmodSync(backup, 0o600)
  return backup
}

/**
 * Apply a conversion to the live root.
 *
 * Existing files are refreshed only when the importer can prove ownership
 * from its state file and the two-frame shape. A missing state entry is
 * deliberately *not* treated as ownership: this prevents a fresh install
 * from overwriting a session created by another tool. `force` is the explicit
 * destructive escape hatch.
 *
 * @param results conversion summaries carrying `dir`, `bodySha256`, and stats
 * @param force refresh an unowned/continued log explicitly
 */
export function syncSessions(scratchRoot, liveRoot, results, force = false) {
  assertSafeRoot(liveRoot)
  const hashFor = new Map()
  for (const result of results) {
    const key = relative(resolve(scratchRoot), resolve(result.dir))
    hashFor.set(key, {
      sha: result.bodySha256,
      imagesSkipped: result.stats?.imagesSkipped ?? 0,
    })
  }
  const state = readState(liveRoot)
  let stateDirty = false
  const setOwnership = (key, bodySha256, importedAt = new Date().toISOString()) => {
    const previous = state.sessions[key]
    if (previous?.bodySha256 === bodySha256 && previous?.importedAt === importedAt) return
    state.sessions[key] = { bodySha256, importedAt }
    stateDirty = true
  }
  const id = runId()
  const buckets = {
    installed: [],
    refreshed: [],
    unchanged: [],
    refused: [],
    backups: [],
    newDigests: {},
    runId: id,
  }

  for (const projectDir of readdirSync(scratchRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory() || projectDir.isSymbolicLink()) continue
    for (const sessionDir of readdirSync(join(scratchRoot, projectDir.name), { withFileTypes: true })) {
      if (!sessionDir.isDirectory() || sessionDir.isSymbolicLink()) continue
      const key = join(projectDir.name, sessionDir.name)
      const from = join(scratchRoot, key)
      let to
      try {
        to = pathForKey(liveRoot, key)
      } catch (error) {
        buckets.refused.push(refusal(key, String(error.message)))
        continue
      }
      if (hasSymlinkAncestor(liveRoot, to)) {
        buckets.refused.push(refusal(key, 'the destination path contains a symbolic-link ancestor'))
        continue
      }
      const wanted = hashFor.get(key)?.sha
      if (typeof wanted !== 'string' || wanted.length === 0) {
        buckets.refused.push(refusal(key, 'conversion did not produce a content digest'))
        continue
      }

      const targetStat = readLinkSafe(to)
      if (targetStat === undefined) {
        try {
          installSession(from, to)
        } catch (error) {
          buckets.refused.push(refusal(key, `could not install safely (${String(error?.message ?? error)})`))
          continue
        }
        buckets.installed.push(key)
        buckets.newDigests[key] = wanted
        setOwnership(key, wanted)
        continue
      }
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        buckets.refused.push(refusal(key, 'the destination is not a regular session directory'))
        continue
      }

      const targetLog = join(to, 'session.v3.jsonl.zstd')
      if (isSymlink(targetLog)) {
        buckets.refused.push(refusal(key, 'the installed session log is a symbolic link'))
        continue
      }
      const current = safeReadLog(targetLog)
      if (current.error !== undefined) {
        buckets.refused.push(refusal(key, `the installed log is unreadable (${current.error})`))
        continue
      }
      if (current.bodySha256 === wanted) {
        if (state.sessions[key] === undefined || state.sessions[key].bodySha256 !== current.bodySha256) {
          buckets.refused.push(refusal(key, 'the installed log already matches, but it has no importer ownership record'))
          continue
        }
        buckets.unchanged.push(key)
        // Preserve the original import timestamp and ownership record. This
        // also means a scoped import never erases records for other sessions.
        setOwnership(key, wanted, state.sessions[key]?.importedAt ?? new Date().toISOString())
        continue
      }

      // A conversion without the attachment store produces a log with image
      // blocks missing. Never replace a richer installed log with that result.
      if ((hashFor.get(key)?.imagesSkipped ?? 0) > 0 && current.hasImages) {
        buckets.refused.push(refusal(
          key,
          'this conversion could not reach the attachment store, so refreshing would drop '
            + `${hashFor.get(key).imagesSkipped} image(s) the installed log already has`,
        ))
        continue
      }

      const recorded = state.sessions[key]
      const ours = current.frames === 2
        && recorded !== undefined
        && recorded.bodySha256 === current.bodySha256
      if (!ours && !force) {
        const reason = current.frames === 2
          ? recorded === undefined
            ? 'the installed log has no importer ownership record'
            : 'the installed log was rewritten after the import'
          : `the session has been continued in DSH (${current.frames} frames, this importer writes 2)`
        buckets.refused.push(refusal(key, reason))
        continue
      }

      let backup
      try {
        backup = backupLog(liveRoot, key, id)
        replaceLog(from, to)
      } catch (error) {
        // If replacement got as far as renaming the staged file, restore the
        // backup before reporting the session as refused. This keeps a partial
        // filesystem error from leaving a half-published log behind.
        if (backup !== undefined && existsSync(backup)) {
          try {
            mkdirSync(to, { recursive: true, mode: 0o700 })
            replaceLog(dirname(backup), to)
          } catch {
            // Preserve the original error in the refusal; a later `--force`
            // run can still recover from the retained backup.
          }
        }
        // Leave the original file in place whenever possible and surface the
        // single-session failure without aborting other sessions.
        buckets.refused.push(refusal(key, `could not refresh safely (${String(error?.message ?? error)})`))
        continue
      }
      buckets.backups.push({
        key,
        backupLog: backup,
        previousBodySha256: current.bodySha256,
        newBodySha256: wanted,
      })
      buckets.refreshed.push(key)
      buckets.newDigests[key] = wanted
      setOwnership(key, wanted)
    }
  }

  // Do not prune unseen entries. A scoped `--session` import must not make
  // every other imported session look foreign on the next run.
  if (stateDirty) writeState(liveRoot, state)
  return buckets
}

/**
 * Write a transactional manifest. Unchanged sessions are intentionally absent:
 * a rollback must never delete a session that this run did not create.
 *
 * A small legacy text file is written as well for older scripts; it lists only
 * newly installed directories and is therefore safe to remove with xargs.
 */
export function writeManifest(liveRoot, buckets) {
  const installed = buckets?.installed ?? []
  const backups = buckets?.backups ?? []
  // A no-op sync has no filesystem change to undo. Preserve the previous
  // manifest (and its immutable archive) instead of replacing it with an empty
  // record whose only effect would be to change metadata mtimes. Returning the
  // prior archive keeps callers' rollback command useful on repeated runs.
  if (installed.length === 0 && backups.length === 0) {
    const latest = manifestPath(liveRoot)
    try {
      const previous = JSON.parse(readFileSync(latest, 'utf8'))
      if (typeof previous?.runId === 'string' && /^[A-Za-z0-9._-]+$/.test(previous.runId)) {
        const archive = archiveManifestPath(liveRoot, previous.runId)
        if (existsSync(archive)) return archive
      }
    } catch {
      // Fall through to the existing convenience path when it is legacy or
      // malformed; the caller can still report that no rollback was created.
    }
    return existsSync(latest) ? latest : undefined
  }
  const id = buckets?.runId ?? runId()
  const detail = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    liveRoot: resolve(liveRoot),
    runId: id,
    remove: installed.map((key) => ({
      key,
      newBodySha256: buckets?.newDigests?.[key],
    })),
    restore: backups.map((entry) => ({ ...entry })),
  }
  const encoded = `${JSON.stringify(detail, null, 2)}\n`
  // Keep the familiar latest-manifest path for scripts, and retain an
  // immutable per-run copy so a later no-op sync cannot erase the undo record
  // printed by an earlier run.
  const path = manifestPath(liveRoot)
  writeAtomic(archiveManifestPath(liveRoot, id), encoded)
  writeAtomic(path, encoded)
  const legacy = installed.map((key) => pathForKey(liveRoot, key)).join('\n')
  writeAtomic(legacyManifestPath(liveRoot), legacy.length > 0 ? `${legacy}\n` : '', 0o600)
  return archiveManifestPath(liveRoot, id)
}

function readManifest(path) {
  const text = readFileSync(path, 'utf8')
  if (text.trimStart().startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid JSON rollback manifest: ${error.message}`, { cause: error })
    }
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.liveRoot !== 'string'
      || parsed.liveRoot.length === 0 || !Array.isArray(parsed.remove) || !Array.isArray(parsed.restore)) {
      throw new Error('invalid rollback manifest: expected version 2 with liveRoot, remove, and restore')
    }
    if (parsed.runId !== undefined
      && (typeof parsed.runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(parsed.runId))) {
      throw new Error('invalid rollback manifest: runId is not safe')
    }
    const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
    for (const entry of parsed.remove) {
      if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string'
        || !digest(entry.newBodySha256)) {
        throw new Error('invalid rollback manifest: remove entries need a key and body digest')
      }
    }
    for (const entry of parsed.restore) {
      if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string'
        || !digest(entry.newBodySha256) || !digest(entry.previousBodySha256)
        || typeof entry.backupLog !== 'string' || entry.backupLog.length === 0) {
        throw new Error('invalid rollback manifest: restore entries need key, backup, and body digests')
      }
    }
    return parsed
  }
  // Pre-0.2 manifests were newline-separated absolute session directories. The
  // sessions root is two levels above each entry; infer it so a legacy file
  // cannot authorize removal of every path in the manifest's parent directory.
  const entries = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const manifestDir = dirname(resolve(path))
  const inferredRoots = entries.map((entry) => dirname(dirname(resolve(entry))))
  const candidate = inferredRoots.length > 0 && inferredRoots.every((root) => root === inferredRoots[0])
    ? inferredRoots[0]
    : undefined
  // A legacy file has no authenticated liveRoot. Only accept an inferred root
  // below the manifest's own directory; otherwise a hand-written file could
  // authorize deletion of an unrelated absolute path.
  const manifestBase = manifestDir === sep ? sep : `${manifestDir}${sep}`
  const liveRoot = candidate !== undefined
    && (candidate === manifestDir || candidate.startsWith(manifestBase))
    ? candidate
    : join(manifestDir, '.codex-import-invalid-root')
  return {
    version: 1,
    liveRoot,
    remove: entries.map((absolute) => ({ absolute })),
    restore: [],
  }
}

function sameRoot(path, root) {
  const candidate = resolve(path)
  const resolvedRoot = resolve(root)
  const base = resolvedRoot === sep ? sep : `${resolvedRoot}${sep}`
  return candidate !== resolvedRoot && candidate.startsWith(base)
}

/**
 * Apply a manifest conservatively. A session changed after the import is
 * skipped, so rollback cannot delete a user's new turn by accident.
 */
export function rollbackManifest(path) {
  const manifest = readManifest(path)
  const liveRoot = resolve(manifest.liveRoot)
  assertSafeRoot(liveRoot)
  const state = readState(liveRoot)
  let removed = 0
  let restored = 0
  let skipped = 0
  let stateDirty = false

  for (const entry of manifest.remove ?? []) {
    if (entry === null || typeof entry !== 'object') {
      skipped += 1
      continue
    }
    let target
    try {
      target = entry.absolute !== undefined ? resolve(entry.absolute) : pathForKey(liveRoot, entry.key)
    } catch {
      skipped += 1
      continue
    }
    if (!sameRoot(target, liveRoot) || hasSymlinkAncestor(liveRoot, target)
      || !existsSync(target) || isSymlink(target)) {
      skipped += 1
      continue
    }
    const targetStat = readLinkSafe(target)
    if (targetStat === undefined || !targetStat.isDirectory()) {
      skipped += 1
      continue
    }
    const log = join(target, 'session.v3.jsonl.zstd')
    if (isSymlink(log)) {
      skipped += 1
      continue
    }
    const current = safeReadLog(log)
    if (current.error !== undefined) {
      skipped += 1
      continue
    }
    if (entry.newBodySha256 !== undefined && current.bodySha256 !== entry.newBodySha256) {
      skipped += 1
      continue
    }
    // Legacy text manifests carry no digest. They may remove only an untouched
    // two-frame import; a continued log must survive even when an old script
    // invokes rollback against it.
    if (entry.newBodySha256 === undefined && current.frames !== 2) {
      skipped += 1
      continue
    }
    // Remove only the imported log. Preserve sibling metadata a user may have
    // added since the import, and remove the directory only when it is empty.
    rmSync(log, { force: true })
    try {
      if (readdirSync(target).length === 0) rmSync(target, { recursive: true, force: true })
    } catch {
      // The log is already gone; a non-empty or concurrently removed directory
      // does not make the rollback unsafe.
    }
    if (entry.key !== undefined && Object.hasOwn(state.sessions, entry.key)) {
      delete state.sessions[entry.key]
      stateDirty = true
    }
    removed += 1
  }

  for (const entry of manifest.restore ?? []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.key !== 'string'
      || typeof entry.newBodySha256 !== 'string' || typeof entry.previousBodySha256 !== 'string') {
      skipped += 1
      continue
    }
    let targetDir
    try {
      targetDir = pathForKey(liveRoot, entry.key)
    } catch {
      skipped += 1
      continue
    }
    const targetLog = join(targetDir, 'session.v3.jsonl.zstd')
    if (hasSymlinkAncestor(liveRoot, targetDir)) {
      skipped += 1
      continue
    }
    const current = safeReadLog(targetLog)
    if (current.bodySha256 !== entry.newBodySha256 || current.frames !== 2) {
      skipped += 1
      continue
    }
    const backupPath = resolve(entry.backupLog ?? '')
    const backupRoot = resolve(metadataRoot(liveRoot), 'codex-import-backups')
    const backupBase = backupRoot === sep ? sep : `${backupRoot}${sep}`
    const backupStat = readLinkSafe(entry.backupLog)
    if (backupStat === undefined || backupStat.isSymbolicLink() || !backupStat.isFile()
      || backupPath === backupRoot || !backupPath.startsWith(backupBase)
      || hasSymlinkAncestor(backupRoot, backupPath)
      || isSymlink(targetDir) || isSymlink(targetLog)) {
      skipped += 1
      continue
    }
    const backup = safeReadLog(backupPath)
    if (backup.error !== undefined || backup.frames !== 2 || backup.bodySha256 !== entry.previousBodySha256) {
      skipped += 1
      continue
    }
    try {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 })
      replaceLog(dirname(backupPath), targetDir)
    } catch {
      skipped += 1
      continue
    }
    const previousOwner = state.sessions[entry.key]
    state.sessions[entry.key] = {
      bodySha256: entry.previousBodySha256,
      importedAt: previousOwner?.importedAt ?? new Date().toISOString(),
    }
    stateDirty = true
    restored += 1
  }

  if (stateDirty) writeState(liveRoot, state)
  const updated = { ...manifest, rolledBackAt: new Date().toISOString(), result: { removed, restored, skipped } }
  const resultId = typeof manifest.runId === 'string' && /^[A-Za-z0-9._-]+$/.test(manifest.runId)
    ? manifest.runId
    : `rollback-${Date.now()}-${randomUUID().slice(0, 8)}`
  const resultPath = rollbackResultPath(liveRoot, resultId)
  writeAtomic(resultPath, `${JSON.stringify(updated, null, 2)}\n`)
  // The mutable convenience manifest may record the outcome. A per-run archive
  // passed explicitly to rollback is never rewritten.
  if (resolve(path) === resolve(manifestPath(liveRoot))) {
    writeAtomic(manifestPath(liveRoot), `${JSON.stringify(updated, null, 2)}\n`)
  }
  return { removed, restored, skipped, resultPath }
}
