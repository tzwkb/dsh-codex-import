/**
 * DSH session log framing and deterministic body utilities.
 *
 * Keeping the physical format separate from Codex record conversion makes the
 * converter easier to audit: one module owns hashes, zstd framing, and atomic
 * publication, while the state machine only produces logical events.
 *
 * @module dsh-codex-import/session-format
 */
import { writeFileSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib'

// Match dsh-session-persistence-jsonl's checksummed frames.
const ZSTD_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/** Canonical plaintext body of a built session, without its header. */
export function sessionBody(built) {
  const [, ...eventRecords] = built.records
  return `${eventRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
}

/** Stable digest used by incremental reconciliation. */
export function bodySha256(built) {
  return createHash('sha256').update(sessionBody(built)).digest('hex')
}

/** Serialize one built session as a header frame followed by an event frame. */
export function serializeSession(built, body = sessionBody(built)) {
  const [headerRecord] = built.records
  const headerFrame = `${JSON.stringify(headerRecord)}\n`
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerFrame, 'utf8'), ZSTD_OPTIONS),
    zstdCompressSync(Buffer.from(body, 'utf8'), ZSTD_OPTIONS),
  ])
}

/** Atomically replace a converted log, cleaning a torn temporary file. */
export function writeSessionAtomic(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
  const existing = (() => {
    try { return lstatSync(path) } catch { return undefined }
  })()
  if (existing?.isSymbolicLink()) throw new Error(`the output session log is a symbolic link: ${path}`)
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`the output session log is not a regular file: ${path}`)
  }
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    const appeared = (() => {
      try { return lstatSync(path) } catch { return undefined }
    })()
    if (appeared?.isSymbolicLink()) throw new Error(`the output session log is a symbolic link: ${path}`)
    if (appeared !== undefined && !appeared.isFile()) {
      throw new Error(`the output session log is not a regular file: ${path}`)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
