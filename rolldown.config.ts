import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { defineConfig } from 'rolldown'

import pkg from './package.json' with { type: 'json' }

/**
 * Bundles the CLI, server and extractors into dist/cli.js. Node refuses to type-strip
 * `.ts` files under node_modules, so the published package must ship JavaScript. Runtime
 * dependencies stay external (installed alongside); vite is only reached with `--dev`.
 *
 * The Python grammar ships as dist/tree-sitter-python.wasm, next to the bundle, rather
 * than as a dependency: its package also carries a native binding with an install script
 * that npm warns about, and only the .wasm is needed.
 */
const external = [...Object.keys(pkg.dependencies), 'vite']
const require = createRequire(import.meta.url)

export default defineConfig({
  input: 'src/cli/main.ts',
  platform: 'node',
  external: (id) =>
    id.startsWith('node:') || external.some((dep) => id === dep || id.startsWith(dep + '/')),
  plugins: [
    {
      name: 'python-grammar',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'tree-sitter-python.wasm',
          source: readFileSync(require.resolve('tree-sitter-python/tree-sitter-python.wasm')),
        })
      },
    },
  ],
  output: {
    file: 'dist/cli.js',
    format: 'esm',
    banner: '#!/usr/bin/env node',
  },
})
