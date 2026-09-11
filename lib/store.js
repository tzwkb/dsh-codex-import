/**
 * Open the DSH attachment store outside a running harness.
 *
 * Images cannot be imported without the store. Codex embeds them as base64 data
 * URLs; DSH holds content-addressed, normalized objects and references them by
 * an `{attachmentId, mediaType, width, height, bytes}` record. The store
 * re-encodes an image before hashing it, so that record cannot be reconstructed
 * from the Codex payload — the only way to get a valid reference is to hand the
 * bytes to the store and keep what it returns.
 *
 * The store is a plain service object with no app-level dependencies, so
 * constructing it directly is enough. Without this, a `sync` from the command
 * line would silently drop every image that a `/import-codex` run had attached.
 *
 * @module dsh-codex-import/store
 */
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshModule } from './verify.js'

/** The active DSH home, matching what the harness itself resolves. */
export function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Open the local attachment store.
 *
 * @returns `{saveImages, root}` — `root` is reported so a caller can say where
 *   the objects went.
 */
export async function openAttachmentStore(dshHome = resolveDshHome()) {
  const load = async (spec) => import(pathToFileURL(resolveDshModule(spec)).href)
  const { Context } = await load('@deepseek-ai/cordis')
  const { LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local')
  const store = new LocalAttachmentStore(new Context(), { dshHome })
  return {
    root: store.root,
    saveImages: (inputs) => store.saveImages(inputs),
  }
}
