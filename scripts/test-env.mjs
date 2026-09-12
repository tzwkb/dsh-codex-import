/**
 * Shared environment for repository-local tests.
 *
 * Tests must never discover the user's global DSH, ~/.dsh, or ~/.codex.  The
 * downloaded runtime lives in `.test-runtime`; all disposable homes, fixtures,
 * and scratch trees live below `.test-work` in this repository.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TEST_RUNTIME_ROOT = join(PROJECT_ROOT, '.test-runtime')
export const TEST_WORK_ROOT = join(PROJECT_ROOT, '.test-work')
export const TEST_DSH_BIN = join(TEST_RUNTIME_ROOT, 'node_modules', '.bin', 'dsh')

/** Configure every importer/validator subprocess to use the local runtime. */
export function configureTestEnvironment() {
  if (!existsSync(TEST_DSH_BIN)) {
    throw new Error(
      `isolated DSH runtime is missing at ${TEST_DSH_BIN}; `
      + 'run: npm run test:setup',
    )
  }
  mkdirSync(TEST_WORK_ROOT, { recursive: true, mode: 0o700 })
  process.env.DSH_CODEX_IMPORT_DSH_BIN = TEST_DSH_BIN
  process.env.DSH_CODEX_IMPORT_TMP_ROOT = TEST_WORK_ROOT
  return { projectRoot: PROJECT_ROOT, runtimeRoot: TEST_RUNTIME_ROOT, workRoot: TEST_WORK_ROOT }
}

/** Create an isolated test tree inside the repository. */
export function makeTestRoot(prefix) {
  configureTestEnvironment()
  return mkdtempSync(join(TEST_WORK_ROOT, `${prefix}-`))
}

/** Remove a test tree unless a caller explicitly wants to inspect it. */
export function cleanTestRoot(root, keep = false) {
  if (!keep) rmSync(root, { recursive: true, force: true })
}
