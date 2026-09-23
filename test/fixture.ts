import { fileURLToPath } from 'node:url'

import type { Ir } from '../src/core/ir.ts'
import { typescriptExtractor } from '../src/lang/ts/extract.ts'

export const LAYERED = fileURLToPath(new URL('./fixtures/layered', import.meta.url))

let cached: Ir | undefined

/** The layered fixture's IR, extracted once per test file. */
export function layeredIr(): Ir {
  if (cached) return cached
  const part = typescriptExtractor.extract(LAYERED)
  cached = { version: 1, root: LAYERED, generatedAt: 'now', ...part }
  return cached
}
