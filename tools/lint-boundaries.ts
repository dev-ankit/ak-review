import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Layer rules for ak-review's own source (it should pass its own dependency check):
 *   core    pure, shared by server and browser: imports only core
 *   lang    extractors: core, node, compiler packages
 *   server  core, lang, node, packages; never web
 *   cli     server, core, lang, node, package.json (version)
 *   web     core and web only; never node or server code
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const slash = (p: string) => p.replaceAll('\\', '/')

const layerOf = (file: string) => slash(file).split('/')[1] ?? ''

const ALLOWED_LOCAL: Record<string, string[]> = {
  core: ['core'],
  lang: ['core', 'lang'],
  server: ['core', 'lang', 'server'],
  cli: ['core', 'lang', 'server', 'cli', 'package.json'],
  web: ['core', 'web'],
}
const PACKAGES_ALLOWED: Record<string, boolean> = {
  core: false,
  lang: true,
  server: true,
  cli: true,
  web: true,
}

const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

export function checkFile(file: string, source: string): string[] {
  const layer = layerOf(file)
  const allowed = ALLOWED_LOCAL[layer]
  if (!allowed) return []
  const errors: string[] = []
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]!
    if (spec.startsWith('.')) {
      const target = slash(relative(root, resolve(root, dirname(file), spec)))
      const targetLayer = target.startsWith('src/') ? layerOf(target) : target
      if (!allowed.includes(targetLayer)) errors.push(`${file}: ${layer} may not import ${target}`)
    } else if (layer === 'web' && spec.startsWith('node:')) {
      errors.push(`${file}: web may not import ${spec}`)
    } else if (!PACKAGES_ALLOWED[layer] && !spec.startsWith('.')) {
      errors.push(`${file}: ${layer} must stay dependency-free (${spec})`)
    }
  }
  return errors
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = walk(join(root, 'src')).flatMap((f) =>
    checkFile(slash(relative(root, f)), readFileSync(f, 'utf8')),
  )
  for (const e of errors) console.error(e)
  if (errors.length > 0) process.exit(1)
  console.log('boundaries ok')
}
