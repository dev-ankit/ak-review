import { basename, posix } from 'node:path'

import picomatch from 'picomatch'

import { type Ir, type IrModule, type IrSymbol, moduleOf } from '../core/ir.ts'
import type { Model, ModelEdge, ModelNode } from '../core/model.ts'
import type { Policy } from './policy.ts'

const ROOT = '/'
const GLOB = { dot: true }

const matcher = (globs: string[]): ((path: string) => boolean) =>
  globs.length === 0 ? () => false : picomatch(globs, GLOB)

/** Apply the policy to the IR: filter, place modules in components, assign layers. */
export function buildModel(ir: Ir, policy: Policy, warnings: string[] = []): Model {
  const included = matcher(policy.include)
  const excluded = matcher(policy.exclude)
  const omittedIds = new Set(policy.omit)
  const omittedGlob = matcher(policy.omit)
  const groups = policy.groups.map((g) => ({
    name: g.name,
    globs: g.match.map((glob) => ({
      test: picomatch(glob, GLOB),
      base: picomatch.scan(glob).base,
    })),
  }))
  const layers = policy.layers.map((l) => ({ name: l.name, test: matcher(l.match) }))

  /** Component path segments for a module: its group's, else its directories. */
  const placement = (id: string): string[] => {
    for (const group of groups) {
      for (const glob of group.globs) {
        if (!glob.test(id)) continue
        const rel = glob.base === '' ? id : id.slice(glob.base.length).replace(/^\//, '')
        return [...group.name.split('/'), ...rel.split('/').slice(0, -1)].filter(Boolean)
      }
    }
    return id.split('/').slice(0, -1)
  }

  const nodes: Record<string, ModelNode> = {
    [ROOT]: { id: ROOT, kind: 'component', name: basename(ir.root), parent: null, children: [] },
  }
  const ensureComponent = (segments: string[]): string => {
    let parent = ROOT
    segments.forEach((segment, i) => {
      const id = segments.slice(0, i + 1).join('/') + '/'
      if (!nodes[id]) {
        nodes[id] = { id, kind: 'component', name: segment, parent, children: [] }
        nodes[parent]!.children.push(id)
      }
      parent = id
    })
    return parent
  }

  const addSymbols = (symbols: IrSymbol[], parent: string, mod: IrModule): void => {
    for (const s of symbols) {
      if (omittedIds.has(s.id)) continue
      nodes[s.id] = {
        id: s.id,
        kind: s.kind,
        name: s.name,
        parent,
        children: [],
        file: mod.id,
        language: mod.language,
        range: s.range,
        loc: s.range.end - s.range.start + 1,
        complexity: s.complexity,
        exported: s.exported,
      }
      nodes[parent]!.children.push(s.id)
      if (s.children) addSymbols(s.children, s.id, mod)
    }
  }

  const layerIndex = new Map<string, number>()
  for (const mod of ir.modules) {
    const id = mod.id
    if (!included(id) || excluded(id) || omittedIds.has(id) || omittedGlob(id)) continue
    const parent = ensureComponent(placement(id))
    const layer = layers.findIndex((l) => l.test(id))
    if (layer >= 0) layerIndex.set(id, layer)
    nodes[id] = {
      id,
      kind: 'module',
      name: posix.basename(id),
      parent,
      children: [],
      file: id,
      language: mod.language,
      loc: mod.loc,
      layer: layers[layer]?.name,
    }
    nodes[parent]!.children.push(id)
    addSymbols(mod.symbols, id, mod)
  }

  const violates = (from: string, to: string): boolean => {
    const a = layerIndex.get(moduleOf(from))
    const b = layerIndex.get(moduleOf(to))
    return a !== undefined && b !== undefined && a > b
  }
  const edges: ModelEdge[] = []
  for (const e of ir.imports) {
    if (!nodes[e.from] || !nodes[e.to]) continue
    const edge: ModelEdge = { from: e.from, to: e.to, kind: 'import' }
    if (e.typeOnly) edge.typeOnly = true
    if (violates(e.from, e.to)) edge.violation = true
    edges.push(edge)
  }
  for (const e of ir.calls) {
    if (!nodes[e.from] || !nodes[e.to]) continue
    const edge: ModelEdge = { from: e.from, to: e.to, kind: 'call', lines: e.lines }
    if (violates(e.from, e.to)) edge.violation = true
    edges.push(edge)
  }

  sortChildren(nodes)
  aggregate(nodes, ROOT)

  // A repo whose code all lives under src/ opens at src/, not at a root with one box.
  let rootId = ROOT
  for (;;) {
    const only = nodes[rootId]!.children
    if (only.length !== 1 || nodes[only[0]!]!.kind !== 'component') break
    delete nodes[rootId]
    rootId = only[0]!
    nodes[rootId]!.parent = null
  }

  return {
    name: basename(ir.root),
    root: ir.root,
    rootId,
    generatedAt: ir.generatedAt,
    nodes,
    edges,
    layers: layers.map((l) => l.name),
    warnings: [...ir.warnings, ...warnings],
  }
}

const KIND_ORDER: Record<string, number> = { component: 0, module: 1 }

function sortChildren(nodes: Record<string, ModelNode>): void {
  for (const node of Object.values(nodes)) {
    node.children.sort((a, b) => {
      const x = nodes[a]!
      const y = nodes[b]!
      if (x.range && y.range) return x.range.start - y.range.start
      const byKind = (KIND_ORDER[x.kind] ?? 2) - (KIND_ORDER[y.kind] ?? 2)
      return byKind !== 0 ? byKind : x.name.localeCompare(y.name)
    })
  }
}

/** Sum loc into components, lift max complexity into modules and components, and give a
 * component a layer when all its modules share one. */
function aggregate(
  nodes: Record<string, ModelNode>,
  id: string,
): { complexity?: number; layers: Set<string | undefined> } {
  const node = nodes[id]!
  let max = node.complexity
  const layers = new Set<string | undefined>()
  if (node.kind === 'module') layers.add(node.layer)
  let loc = 0
  for (const child of node.children) {
    const sub = aggregate(nodes, child)
    if (sub.complexity !== undefined && (max === undefined || sub.complexity > max)) {
      max = sub.complexity
    }
    for (const layer of sub.layers) layers.add(layer)
    loc += nodes[child]!.loc ?? 0
  }
  if (node.kind === 'component') {
    node.loc = loc
    const [only] = layers
    if (layers.size === 1 && only !== undefined) node.layer = only
  }
  if ((node.kind === 'component' || node.kind === 'module') && max !== undefined) {
    node.complexity = max
  }
  return {
    complexity: max,
    layers: node.kind === 'component' || node.kind === 'module' ? layers : new Set(),
  }
}
