import { fileURLToPath } from 'node:url'

import type { Ir } from '../src/core/ir.ts'
import type { Extractor } from '../src/lang/extractor.ts'
import { pythonExtractor } from '../src/lang/py/extract.ts'
import { typescriptExtractor } from '../src/lang/ts/extract.ts'

export const LAYERED = fileURLToPath(new URL('./fixtures/layered', import.meta.url))
export const PYTHON_LAYERED = fileURLToPath(new URL('./fixtures/python-layered', import.meta.url))

async function extractFixture(extractor: Extractor, root: string): Promise<Ir> {
  return { version: 1, root, generatedAt: 'now', ...(await extractor.extract(root)) }
}

/** The layered fixture's IR (TypeScript). */
export function layeredIr(): Promise<Ir> {
  return extractFixture(typescriptExtractor, LAYERED)
}

/** The python-layered fixture's IR, the Python twin of the layered one. */
export function pythonLayeredIr(): Promise<Ir> {
  return extractFixture(pythonExtractor, PYTHON_LAYERED)
}
