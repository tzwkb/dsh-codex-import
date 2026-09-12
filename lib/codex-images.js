/**
 * Image decoding and attachment admission for Codex records.
 *
 * The converter uses a content hash of the original bytes as an in-memory
 * lookup key.  The durable reference still comes from DSH's attachment store,
 * which may normalise the bytes before storing them.
 *
 * @module dsh-codex-import/codex-images
 */
import { createHash } from 'node:crypto'
import { eventUserPayload } from './codex-message.js'

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s
/** Refuse pathological inline payloads before Buffer.from allocates them. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024

function estimatedBase64Bytes(encoded) {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding)
}

function originalKey(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Decode one Codex image data URL. */
export function decodeDataUrl(dataUrl, options = {}) {
  const match = typeof dataUrl === 'string' ? DATA_URL_RE.exec(dataUrl) : null
  if (match === null) return undefined
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : MAX_IMAGE_BYTES
  if (estimatedBase64Bytes(match[2]) > maxBytes) return undefined
  let bytes
  try {
    bytes = Buffer.from(match[2], 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0) return undefined
  return { bytes, mediaType: match[1], key: originalKey(bytes) }
}

/** Decode the raw base64 result used by image-generation items. */
export function decodeGeneratedImage(value, hintedMediaType = 'image/png') {
  if (typeof value !== 'string') return undefined
  if (value.startsWith('data:')) return decodeDataUrl(value)
  const encoded = value.trim()
  if (encoded.length < 16 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined
  if (estimatedBase64Bytes(encoded) > MAX_IMAGE_BYTES) return undefined
  let bytes
  try { bytes = Buffer.from(encoded, 'base64') } catch { return undefined }
  if (bytes.length === 0) return undefined
  let mediaType
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mediaType = 'image/png'
  else if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) mediaType = 'image/jpeg'
  else if (bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a')) mediaType = 'image/gif'
  else if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mediaType = 'image/webp'
  else return undefined
  // The hint is retained in the signature for callers that already pass it;
  // magic-byte detection is safer than trusting an unverified MIME label.
  void hintedMediaType
  return { bytes, mediaType, key: originalKey(bytes) }
}

/** Find an image-generation result in the several payload shapes Codex used. */
export function generatedImageOf(payload, seen = new Set(), depth = 0) {
  if (payload === null || typeof payload !== 'object' || seen.has(payload) || depth > 8) return undefined
  seen.add(payload)
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const decoded = generatedImageOf(entry, seen, depth + 1)
      if (decoded !== undefined) return decoded
    }
    return undefined
  }
  const hinted = typeof payload.media_type === 'string' ? payload.media_type
    : typeof payload.mime_type === 'string' ? payload.mime_type
      : typeof payload.mediaType === 'string' ? payload.mediaType
        : typeof payload.mimeType === 'string' ? payload.mimeType : 'image/png'
  for (const key of [
    'result', 'image', 'image_b64', 'image_base64', 'partial_image_b64',
    'b64_json', 'b64Json', 'image_data', 'imageData',
  ]) {
    const candidate = payload[key]
    if (typeof candidate !== 'string') continue
    const decoded = decodeGeneratedImage(candidate, hinted)
    if (decoded !== undefined) return decoded
  }
  for (const nestedKey of ['result', 'output', 'data', 'event', 'item', 'image', 'images', 'content']) {
    if (payload[nestedKey] && typeof payload[nestedKey] === 'object') {
      const decoded = generatedImageOf(payload[nestedKey], seen, depth + 1)
      if (decoded !== undefined) return decoded
    }
  }
  return undefined
}

/** Find all inline data-URL images in a Codex content array. */
export function imagesOf(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = String(block.type ?? '')
    const imageUrl = type === 'input_image' ? block.image_url
      : type === 'image' ? block.url ?? block.image_url
        : type === 'inputImage' ? block.imageUrl ?? block.image_url : undefined
    const decoded = decodeDataUrl(imageUrl)
    if (decoded !== undefined) out.push(decoded)
  }
  return out
}

function remember(unique, image) {
  if (image !== undefined && !unique.has(image.key)) {
    unique.set(image.key, { bytes: image.bytes, mediaType: image.mediaType })
  }
}

/** Every distinct image across a set of conversations, keyed by content hash. */
export function collectImages(conversations) {
  const unique = new Map()
  const note = (content) => {
    for (const image of imagesOf(content)) remember(unique, image)
  }
  for (const convo of conversations ?? []) {
    for (const segment of convo.segments ?? []) {
      for (const record of segment.records ?? []) {
        const payload = record?.payload
        const type = String(payload?.type ?? '').toLowerCase()
        if (record.type === 'response_item'
          && (type === 'message' || type === 'usermessage' || payload?.role === 'user')) {
          note(payload.content)
        } else if (record.type === 'response_item'
          && type.replace(/[_-]/g, '').includes('imagegeneration')) {
          remember(unique, generatedImageOf(payload))
        } else if (record.type === 'event_msg') {
          const user = eventUserPayload(payload)
          if (user !== undefined) note(user.payload.content)
          remember(unique, generatedImageOf(payload))
        } else if (record.type === 'compacted') {
          for (const entry of payload?.replacement_history ?? []) note(entry?.content)
        }
      }
    }
  }
  return unique
}

/** Admit images one at a time, isolating unsupported or oversized inputs. */
export async function admitImages(conversations, saveImages, refs = new Map(), refusalMap = new Map()) {
  if (saveImages === undefined) return { refs, refusals: [...refusalMap.values()] }
  for (const [key, image] of collectImages(conversations)) {
    if (refs.has(key) || refusalMap.has(key)) continue
    try {
      const [ref] = await saveImages([{ data: image.bytes, mediaType: image.mediaType }])
      if (ref === undefined) throw new Error('store returned no reference')
      refs.set(key, ref)
    } catch (error) {
      refusalMap.set(key, { key, mediaType: image.mediaType, reason: String(error?.message ?? error) })
    }
  }
  return { refs, refusals: [...refusalMap.values()] }
}
