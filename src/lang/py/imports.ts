import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { parse } from 'smol-toml'
import type { Node } from 'web-tree-sitter'

/**
 * Python import resolution, done here rather than by Pyright: it is deterministic and
 * needs no interpreter. Absolute imports are looked up under the source roots; relative
 * ones from the importing module's package.
 */

export interface PyImport {
  /** Leading dots of a relative import; 0 for an absolute one. */
  level: number
  /** The dotted module path after the dots; empty for `from . import x`. */
  module: string[]
  /** `from m import a, b` imports names (`[]` for `*`); `import m` has none. */
  names?: string[]
  /** Under `if TYPE_CHECKING:`. */
  typeOnly: boolean
}

/** Every import statement in the file, including the ones inside functions. */
export function collectImports(root: Node): PyImport[] {
  const out: PyImport[] = []
  const visit = (node: Node, typeOnly: boolean): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'import_statement') {
        for (const name of child.childrenForFieldName('name')) {
          out.push({ level: 0, module: dotted(name), typeOnly })
        }
      } else if (child.type === 'import_from_statement') {
        const [level, module] = fromModule(child.childForFieldName('module_name'))
        const names = child.childrenForFieldName('name').map((n) => dotted(n).join('.'))
        out.push({ level, module, names, typeOnly })
      } else if (child.type === 'if_statement' && isTypeChecking(child)) {
        // Node objects are fresh wrappers per access: compare ids, not references.
        const consequence = child.childForFieldName('consequence')?.id
        for (const part of child.namedChildren) visit(part, typeOnly || part.id === consequence)
      } else if (child.type !== 'future_import_statement') {
        visit(child, typeOnly)
      }
    }
  }
  visit(root, false)
  return out
}

/** `a.b` or `a.b as c` → ['a', 'b']. */
function dotted(node: Node): string[] {
  const name = node.type === 'aliased_import' ? node.childForFieldName('name') : node
  return name?.type === 'dotted_name' ? name.namedChildren.map((part) => part.text) : []
}

function fromModule(node: Node | null): [level: number, module: string[]] {
  if (node?.type !== 'relative_import') return [0, node ? dotted(node) : []]
  const prefix = node.namedChildren.find((c) => c.type === 'import_prefix')
  const rest = node.namedChildren.find((c) => c.type === 'dotted_name')
  return [prefix?.text.length ?? 0, rest ? dotted(rest) : []]
}

function isTypeChecking(node: Node): boolean {
  const condition = node.childForFieldName('condition')?.text ?? ''
  return /^(\w+\.)*TYPE_CHECKING$/.test(condition)
}

export interface Resolution {
  /** Repo modules the import binds; empty for third-party and unresolvable imports. */
  targets: string[]
  /** Top-level package of an absolute import no source root has. */
  external?: string
}

/**
 * Resolves imports against the repo's own modules. `import a.b.c` binds `a/b/c.py` (or
 * `a/b/c/__init__.py`), falling back to the deepest parent that exists. `from m import x`
 * binds submodule `m/x.py` when there is one, and `m` itself otherwise.
 */
export class ImportResolver {
  private readonly modules: Set<string>
  private readonly roots: string[]

  constructor(modules: Iterable<string>, roots: string[]) {
    this.modules = new Set(modules)
    this.roots = roots
  }

  resolve(from: string, imp: PyImport): Resolution {
    if (imp.level > 0) {
      let base = posix.dirname(from)
      for (let i = 1; i < imp.level; i++) {
        if (base === '.') return { targets: [] }
        base = posix.dirname(base)
      }
      return { targets: this.bind(base === '.' ? '' : base, imp, 0) }
    }
    if (imp.module.length === 0) return { targets: [] }
    for (const root of this.roots) {
      const targets = this.bind(root, imp, 1)
      if (targets.length > 0) return { targets }
    }
    return { targets: [], external: imp.module[0] }
  }

  /** `min` is the shortest module path that counts: 1 for absolute imports, so a root's own
   * `__init__.py` never matches. */
  private bind(base: string, imp: PyImport, min: number): string[] {
    const [file, exact] = this.deepest(base, imp.module, min)
    if (imp.names === undefined || !exact) return file ? [file] : []
    const targets = new Set<string>()
    for (const name of imp.names) {
      const sub = this.file(base, [...imp.module, name])
      if (sub) targets.add(sub)
      else if (file) targets.add(file)
    }
    if (imp.names.length === 0 && file) targets.add(file)
    return [...targets]
  }

  /** The module file for the longest resolvable prefix of `parts`, and whether it is all of them. */
  private deepest(
    base: string,
    parts: string[],
    min: number,
  ): [file: string | undefined, exact: boolean] {
    for (let n = parts.length; n >= min; n--) {
      const file = this.file(base, parts.slice(0, n))
      if (file) return [file, n === parts.length]
    }
    // A namespace package (a directory without __init__.py) still has submodules.
    return [undefined, true]
  }

  private file(base: string, parts: string[]): string | undefined {
    const path = [base, ...parts].filter((p) => p !== '').join('/')
    if (path !== '' && this.modules.has(path + '.py')) return path + '.py'
    const init = path === '' ? '__init__.py' : path + '/__init__.py'
    return this.modules.has(init) ? init : undefined
  }
}

const PROJECT_FILE = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/

/**
 * Where absolute imports are looked up, repo-relative ('' is the repo root): package
 * directories declared in each `pyproject.toml`, then every project directory's `src/`,
 * then the project directory itself.
 */
export function sourceRoots(root: string, files: string[], warnings: string[]): string[] {
  const declared: string[] = []
  const conventional: string[] = []
  const projects = new Set([''])
  for (const f of files) if (PROJECT_FILE.test(f)) projects.add(dirOf(f))
  const hasModulesUnder = (dir: string) =>
    files.some((f) => f.endsWith('.py') && f.startsWith(dir + '/'))
  for (const dir of projects) {
    const pyproject = posix.join(dir, 'pyproject.toml')
    if (files.includes(pyproject)) {
      try {
        const doc = parse(readFileSync(join(root, pyproject), 'utf8'))
        for (const d of packageDirs(doc)) declared.push(clean(posix.join(dir, d)))
      } catch (e) {
        warnings.push(`${pyproject}: ${(e as Error).message}`)
      }
    }
    const src = posix.join(dir, 'src')
    if (hasModulesUnder(src)) conventional.push(src)
  }
  return [...new Set([...declared, ...conventional, ...[...projects].sort()])]
}

/** Directories holding top-level packages, per setuptools, hatch and poetry config. */
function packageDirs(doc: Record<string, unknown>): string[] {
  const get = (...path: string[]): unknown =>
    path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], doc)
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  const dirs: string[] = []
  const packageDir = get('tool', 'setuptools', 'package-dir', '')
  if (typeof packageDir === 'string') dirs.push(packageDir)
  dirs.push(...strings(get('tool', 'setuptools', 'packages', 'find', 'where')))
  for (const p of strings(get('tool', 'hatch', 'build', 'targets', 'wheel', 'packages'))) {
    dirs.push(posix.dirname(p))
  }
  const poetry = get('tool', 'poetry', 'packages')
  if (Array.isArray(poetry)) {
    for (const p of poetry) {
      const from = (p as Record<string, unknown>)?.from
      if (typeof from === 'string') dirs.push(from)
    }
  }
  return dirs
}

function dirOf(file: string): string {
  const dir = posix.dirname(file)
  return dir === '.' ? '' : dir
}

function clean(dir: string): string {
  const normalized = posix.normalize(dir).replace(/\/+$/, '')
  return normalized === '.' ? '' : normalized
}
