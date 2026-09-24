import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { Language, Parser } from 'web-tree-sitter'

/**
 * tree-sitter's Python grammar on the WebAssembly runtime, so there is no native build.
 * The published bundle carries the grammar next to itself (see rolldown.config.ts); from
 * source it comes from the `tree-sitter-python` dev dependency. Positions are 0-based rows
 * and UTF-16 columns, which is what LSP expects too.
 */

const GRAMMAR = 'tree-sitter-python.wasm'

let parser: Promise<Parser> | undefined

export function pythonParser(): Promise<Parser> {
  parser ??= (async () => {
    await Parser.init()
    const bundled = fileURLToPath(new URL(GRAMMAR, import.meta.url))
    const wasm = existsSync(bundled)
      ? bundled
      : createRequire(import.meta.url).resolve(`tree-sitter-python/${GRAMMAR}`)
    return new Parser().setLanguage(await Language.load(readFileSync(wasm)))
  })()
  return parser
}
