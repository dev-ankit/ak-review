import type { Ir } from '../core/ir.ts'
import type { Extractor } from './extractor.ts'
import { typescriptExtractor } from './ts/extract.ts'

export const extractors: Extractor[] = [typescriptExtractor]

/** Run every extractor over the repo and merge the results into one IR. */
export function extractAll(root: string, using: Extractor[] = extractors): Ir {
  const ir: Ir = {
    version: 1,
    root,
    generatedAt: new Date().toISOString(),
    modules: [],
    imports: [],
    calls: [],
    warnings: [],
  }
  for (const extractor of using) {
    try {
      const part = extractor.extract(root)
      ir.modules.push(...part.modules)
      ir.imports.push(...part.imports)
      ir.calls.push(...part.calls)
      ir.warnings.push(...part.warnings.map((w) => `${extractor.name}: ${w}`))
    } catch (e) {
      ir.warnings.push(`${extractor.name} failed: ${(e as Error).stack ?? e}`)
    }
  }
  return ir
}
