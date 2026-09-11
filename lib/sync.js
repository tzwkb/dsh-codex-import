/**
 * Reconcile a fresh conversion against a live sessions root.
 *
 * This is the part that makes a repeated import incremental. The session log is
 * an append-only, multi-frame zstd file, so "has this conversation already been
 * imported?" is not the useful question — the useful question is whether the
 * file on disk still holds exactly what a fresh conversion would produce.
 * Answering that with a content digest (rather than a timestamp, a record count
 * or a file size) means a refresh happens when, and only when, the imported
 * content would actually differ.
 *
 * @module dsh-codex-import/sync
 */
import {
  cpSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync,
  renameSync, chmodSync, rmSync,
} from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { readSessionLog } from './verify.js'

/**
 * Record of what this importer last wrote, per installed session.
 *
 * The body hash is not a cache — it is the test for "is the file on disk still
 * the one I wrote?". Without it, a log the harness rewrote internally (a
 * compaction can fold a session back down to two frames) would be
 * indistinguishable from one of ours, and a refresh would silently overwrite
 * real turns.
 */
export function statePath(liveRoot) {
  return join(liveRoot, '..', 'codex-import-state.json')
}

/** Rollback list: every session directory this importer manages. */
export function manifestPath(liveRoot) {
  return join(liveRoot, '..', 'codex-import-manifest.txt')
}

export function readState(liveRoot) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(liveRoot), 'utf8'))
    if (parsed?.version === 1 && typeof parsed.sessions === 'object' && parsed.sessions !== null) return parsed
  } catch {
    // Missing or unreadable state is not fatal: every session it cannot vouch
    // for is simply treated as not-ours, and left alone unless it is untouched.
  }
  return { version: 1, sessions: {} }
}

/** Replace one installed log in place, so sibling files in the dir survive. */
function replaceLog(from, to) {
  const target = join(to, 'session.v3.jsonl.zstd')
  const staged = join(to, `.session.v3.jsonl.zstd.tmp-${process.pid}`)
  try {
    cpSync(join(from, 'session.v3.jsonl.zstd'), staged)
    chmodSync(staged, 0o600)
    renameSync(staged, target)
  } finally {
    rmSync(staged, { force: true })
  }
}

/**
 * Apply a conversion to the live root.
 *
 * Per session, exactly one of four things is true:
 *
 *  - `installed` — not present yet; copy it in.
 *  - `unchanged` — the installed log already holds byte-identical content, so
 *                  nothing is written at all. This is the common case when an
 *                  import is re-run, and it is what makes a refresh cheap.
 *  - `refreshed` — same conversation, different content: it grew in Codex, or
 *                  it was written by an older converter (a different
 *                  tool-output limit, or images that a CLI import could not
 *                  attach). Replaced in place, so the session id, the project
 *                  directory and any workspace state stay valid.
 *  - `refused`   — the installed log is not the one this importer wrote: it has
 *                  been continued in DSH (the harness appends one frame per
 *                  event batch, so it is no longer a two-frame log), or
 *                  something rewrote it. Refreshing would delete real turns, so
 *                  it is left completely alone.
 *
 * @param results - conversion summaries, each carrying `dir` and `bodySha256`.
 * @param force - refresh even a log that is not ours. Destructive by design.
 */
export function syncSessions(scratchRoot, liveRoot, results, force = false) {
  const hashFor = new Map()
  for (const r of results) {
    hashFor.set(relative(scratchRoot, r.dir), { sha: r.bodySha256, imagesSkipped: r.stats?.imagesSkipped ?? 0 })
  }
  const state = readState(liveRoot)
  const buckets = { installed: [], refreshed: [], unchanged: [], refused: [] }
  const seen = new Set()

  for (const projectDir of readdirSync(scratchRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    for (const sessionDir of readdirSync(join(scratchRoot, projectDir.name), { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      const key = join(projectDir.name, sessionDir.name)
      seen.add(key)
      const from = join(scratchRoot, key)
      const to = join(liveRoot, key)
      const wanted = hashFor.get(key)?.sha

      if (!existsSync(to)) {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
        cpSync(from, to, { recursive: true })
        buckets.installed.push(key)
        state.sessions[key] = { bodySha256: wanted, importedAt: new Date().toISOString() }
        continue
      }

      const current = readSessionLog(join(to, 'session.v3.jsonl.zstd'))
      if (current.bodySha256 === wanted) {
        buckets.unchanged.push(key)
        state.sessions[key] = { bodySha256: wanted, importedAt: state.sessions[key]?.importedAt ?? new Date().toISOString() }
        continue
      }

      // A conversion without the attachment store produces a log with the
      // image blocks missing. That is strictly worse than what is installed, so
      // it is a refusal rather than a refresh.
      if ((hashFor.get(key)?.imagesSkipped ?? 0) > 0 && current.hasImages) {
        buckets.refused.push({
          key,
          reason: 'this conversion could not reach the attachment store, so refreshing would drop '
            + `${hashFor.get(key).imagesSkipped} image(s) the installed log already has`,
        })
        continue
      }

      const recorded = state.sessions[key]
      const ours = current.frames === 2 && (recorded === undefined || recorded.bodySha256 === current.bodySha256)
      if (!ours && !force) {
        buckets.refused.push({
          key,
          reason: current.frames === 2
            ? 'the installed log was rewritten after the import'
            : `the session has been continued in DSH (${current.frames} frames, this importer writes 2)`,
        })
        // Keep the previous record: it still describes a file we wrote, and
        // dropping it would make the next run treat the log as unowned.
        continue
      }

      replaceLog(from, to)
      buckets.refreshed.push(key)
      state.sessions[key] = { bodySha256: wanted, importedAt: new Date().toISOString() }
    }
  }

  for (const key of Object.keys(state.sessions)) if (!seen.has(key)) delete state.sessions[key]
  writeFileSync(statePath(liveRoot), `${JSON.stringify(state, null, 2)}\n`)
  return buckets
}

/** Rollback list, written from every bucket the importer is responsible for. */
export function writeManifest(liveRoot, buckets) {
  const managed = [...buckets.installed, ...buckets.refreshed, ...buckets.unchanged].map((key) => join(liveRoot, key))
  const path = manifestPath(liveRoot)
  writeFileSync(path, `${managed.join('\n')}\n`)
  return path
}
