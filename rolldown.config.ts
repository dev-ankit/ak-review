import { defineConfig } from 'rolldown'

import pkg from './package.json' with { type: 'json' }

/**
 * Bundles the CLI, server and extractors into dist/cli.js. Node refuses to type-strip
 * `.ts` files under node_modules, so the published package must ship JavaScript. Runtime
 * dependencies stay external (installed alongside); vite is only reached with `--dev`.
 */
const external = [...Object.keys(pkg.dependencies), 'vite']

export default defineConfig({
  input: 'src/cli/main.ts',
  platform: 'node',
  external: (id) =>
    id.startsWith('node:') || external.some((dep) => id === dep || id.startsWith(dep + '/')),
  output: {
    file: 'dist/cli.js',
    format: 'esm',
    banner: '#!/usr/bin/env node',
  },
})
