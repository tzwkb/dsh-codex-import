/**
 * Small synchronous decoder for concatenated standard zstd frames.
 *
 * Node's `zstdDecompressSync` decodes one frame at a time. Codex and DSH both
 * append independent frames, so callers must locate each exact frame boundary
 * before handing it to Node. Keeping the parser in one module prevents source
 * discovery and generated-log verification from disagreeing about framing.
 *
 * @module dsh-codex-import/zstd
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Read one standard zstd frame's exact byte length. */
function frameLength(buf, start) {
  let offset = start
  const requireBytes = (count, what) => {
    if (offset + count > buf.length) throw new Error(`truncated zstd ${what} at byte ${offset}`)
  }
  requireBytes(5, 'frame header')
  if (!buf.subarray(offset, offset + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
    throw new Error(`invalid zstd frame magic at byte ${offset}`)
  }
  offset += ZSTD_MAGIC.length
  const descriptor = buf[offset++]
  // Bits 4 and 3 are reserved in a standard frame and must be zero.
  if ((descriptor & 0x18) !== 0) throw new Error(`invalid zstd frame descriptor at byte ${start + 4}`)
  const singleSegment = (descriptor & 0x20) !== 0
  const fcsFlag = descriptor >>> 6
  const dictionaryFlag = descriptor & 0x03
  if (!singleSegment) {
    requireBytes(1, 'window descriptor')
    offset += 1
  }
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag]
  requireBytes(dictionaryBytes, 'dictionary id')
  offset += dictionaryBytes
  const contentSizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0)
    : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  requireBytes(contentSizeBytes, 'content size')
  offset += contentSizeBytes

  while (true) {
    requireBytes(3, 'block header')
    const blockHeader = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
    // Raw and compressed blocks carry blockSize bytes. An RLE block stores one
    // byte which is repeated blockSize times.
    const payloadBytes = blockType === 1 ? 1 : blockSize
    requireBytes(payloadBytes, 'block payload')
    offset += payloadBytes
    if (!lastBlock) continue
    if ((descriptor & 0x04) !== 0) {
      requireBytes(4, 'content checksum')
      offset += 4
    }
    return offset - start
  }
}

/** Decode every concatenated frame into plaintext byte buffers. */
export function decodeFrameBuffers(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < ZSTD_MAGIC.length) throw new Error('no zstd frame found')
  const chunks = []
  let offset = 0
  while (offset < buf.length) {
    if (!buf.subarray(offset, offset + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      throw new Error(`invalid zstd frame boundary at byte ${offset}`)
    }
    const length = frameLength(buf, offset)
    const end = offset + length
    try {
      chunks.push(zstdDecompressSync(buf.subarray(offset, end)))
    } catch (error) {
      throw new Error(`invalid zstd frame at byte ${offset}: ${error.message}`, { cause: error })
    }
    offset = end
  }
  return chunks
}

/** Decode every concatenated frame into its plaintext UTF-8 string. */
export function decodeFrames(buf) {
  return decodeFrameBuffers(buf).map((chunk) => chunk.toString('utf8'))
}
