import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Node } from 'web-tree-sitter'

import type { CallEdge, ImportEdge, IrModule } from '../../core/ir.ts'
import {
  countLoc,
  type Extraction,
  type Extractor,
  listRepoFiles,
  toModuleId,
} from '../extractor.ts'
import { collectImports, ImportResolver, sourceRoots } from './imports.ts'
import { pythonParser } from './parser.ts'
import { type Position, Pyright } from './pyright.ts'
import { extractSymbols } from './symbols.ts'

/**
 * Python extractor. tree-sitter gives structure (symbols, ranges, complexity, imports,
 * call sites), imports are resolved against the repo's source roots here, and Pyright's
 * call hierarchy resolves calls: the outgoing calls of every function and method, plus the
 * callee of each call in module and class bodies.
 */

export const pythonExtractor: Extractor = {
  name: 'python',
  extensions: ['.py'],
  configFiles: /(^|\/)(pyproject\.toml|setup\.cfg|pyrightconfig\.json)$/,
  extract: extractPython,
}

/** Files in flight at once. Pyright is single-threaded; this only hides round trips. */
const CONCURRENT_FILES = 4

interface Parsed {
  id: string
  text: string
  /** Functions and methods: their ids and name positions, for outgoing calls. */
  defs: { id: string; at: Position }[]
  /** Calls outside any function (module and class bodies, lambdas): the called name. */
  sites: { owner: string; name: string; at: Position }[]
}

export async function extractPython(root: string): Promise<Extraction> {
  const warnings: string[] = []
  const files = listRepoFiles(root)
  const pyFiles = files.filter((f) => f.endsWith('.py')).sort()
  if (pyFiles.length === 0) return { modules: [], imports: [], calls: [], warnings }

  const parser = await pythonParser()
  const roots = sourceRoots(root, files, warnings)
  const resolver = new ImportResolver(pyFiles, roots)

  // Pass 1 (tree-sitter): symbols, imports, call sites. Symbols are keyed by the position
  // of their name, which is where Pyright's answers point.
  const byKey = new Map<string, string>()
  /** Names that can reach a repo symbol: symbol names and import aliases. */
  const reachable = new Set<string>()
  const modules: IrModule[] = []
  const imports = new Map<string, ImportEdge>()
  const parsed: Parsed[] = []
  for (const id of pyFiles) {
    const text = readFileSync(join(root, id), 'utf8')
    const tree = parser.parse(text)
    if (!tree) {
      warnings.push(`could not parse ${id}`)
      continue
    }
    try {
      const scopes = new Map<number, string>()
      const defs: Parsed['defs'] = []
      const symbols = extractSymbols(tree.rootNode, id, (scope, name, symbolId, isDef) => {
        const at = { line: name.startPosition.row, character: name.startPosition.column }
        byKey.set(`${id}:${at.line}:${at.character}`, symbolId)
        reachable.add(name.text)
        if (isDef) defs.push({ id: symbolId, at })
        scopes.set(scope.id, isDef ? '' : symbolId)
      })

      const externals = new Set<string>()
      for (const imp of collectImports(tree.rootNode)) {
        const { targets, external } = resolver.resolve(id, imp)
        if (external !== undefined && external !== '__future__') externals.add(external)
        for (const target of targets) {
          if (target === id) continue
          const key = id + ' -> ' + target
          const edge = imports.get(key)
          if (edge) edge.typeOnly &&= imp.typeOnly
          else imports.set(key, { from: id, to: target, typeOnly: imp.typeOnly })
        }
      }
      for (const alias of tree.rootNode.descendantsOfType('aliased_import')) {
        const name = alias.childForFieldName('alias')
        if (name) reachable.add(name.text)
      }

      modules.push({
        id,
        language: 'python',
        loc: countLoc(text),
        symbols,
        externals: [...externals].sort(),
      })
      parsed.push({ id, text, defs, sites: callSites(tree.rootNode, id, scopes) })
    } finally {
      tree.delete()
    }
  }

  // Pass 2 (Pyright): callees, mapped back onto symbols by the position of their name.
  const calls = new Map<string, CallEdge>()
  const addCall = (from: string, to: string, line: number) => {
    if (from === to) return
    const key = from + ' -> ' + to
    const edge = calls.get(key)
    if (!edge) calls.set(key, { from, to, lines: [line] })
    else if (!edge.lines.includes(line)) edge.lines.push(line)
  }
  const symbolAt = (uri: string, { line, character }: Position) =>
    uri.startsWith('file:')
      ? byKey.get(`${toModuleId(root, fileURLToPath(uri))}:${line}:${character}`)
      : undefined

  const work = parsed
    .map((file) => ({ ...file, sites: file.sites.filter((s) => reachable.has(s.name)) }))
    .filter((file) => file.defs.length > 0 || file.sites.length > 0)
  if (work.length > 0) {
    let pyright: Pyright | undefined
    try {
      pyright = await Pyright.start(root, {
        extraPaths: roots.filter((r) => r !== '').map((r) => join(root, r)),
        pythonPath: venvPython(root),
      })
      const server = pyright
      server.open(work.map((file) => ({ path: join(root, file.id), text: file.text })))
      await forEachConcurrently(work, CONCURRENT_FILES, async (file) => {
        const path = join(root, file.id)
        const outgoing = file.defs.map(async (def) => {
          for (const call of (await server.outgoingCalls(path, def.at)) ?? []) {
            const target = symbolAt(call.to.uri, call.to.selectionRange.start)
            if (target) for (const r of call.fromRanges) addCall(def.id, target, r.start.line + 1)
          }
        })
        const direct = file.sites.map(async (site) => {
          const callee = await server.callee(path, site.at)
          const target = callee && symbolAt(callee.uri, callee.selectionRange.start)
          if (target) addCall(site.owner, target, site.at.line + 1)
        })
        await Promise.all([...outgoing, ...direct])
      })
    } catch (e) {
      warnings.push(`call resolution failed, calls are incomplete: ${(e as Error).message}`)
    } finally {
      await pyright?.shutdown()
    }
  }

  for (const edge of calls.values()) edge.lines.sort((a, b) => a - b)
  const byEnds = (a: CallEdge, b: CallEdge) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  return {
    modules,
    imports: [...imports.values()],
    calls: [...calls.values()].sort(byEnds),
    warnings,
  }
}

/**
 * Calls outside functions (`f()`, `a.b.f()`), with the symbol they run under. `scopes` maps
 * a symbol's node to its id; an empty id marks a def, whose calls the call hierarchy covers.
 */
function callSites(root: Node, moduleId: string, scopes: Map<number, string>): Parsed['sites'] {
  const sites: Parsed['sites'] = []
  const visit = (node: Node, owner: string): void => {
    const scope = scopes.get(node.id)
    if (scope === '') return
    owner = scope ?? owner
    if (node.type === 'call') {
      const fn = node.childForFieldName('function')
      const name =
        fn?.type === 'identifier'
          ? fn
          : fn?.type === 'attribute'
            ? fn.childForFieldName('attribute')
            : null
      if (name) {
        const at = { line: name.startPosition.row, character: name.startPosition.column }
        sites.push({ owner, name: name.text, at })
      }
    }
    for (const child of node.namedChildren) visit(child, owner)
  }
  visit(root, moduleId)
  return sites
}

/** The repo's virtualenv interpreter, so Pyright can see installed packages. */
function venvPython(root: string): string | undefined {
  for (const venv of ['.venv', 'venv']) {
    for (const bin of ['Scripts/python.exe', 'bin/python']) {
      const path = join(root, venv, bin)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

async function forEachConcurrently<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
