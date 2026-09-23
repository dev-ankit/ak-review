import type { Language, Range, SymbolKind } from './ir.ts'

/**
 * The IR after the policy has been applied: one tree of components, modules and symbols,
 * plus the edges between visible nodes. The server builds it; the browser renders it.
 */

export type NodeKind = 'component' | 'module' | SymbolKind

export interface ModelNode {
  /** Components end in `/` (root is `/`), modules are file paths, symbols contain `#`. */
  id: string
  kind: NodeKind
  name: string
  parent: string | null
  children: string[]
  /** Module file this node lives in (modules and symbols). */
  file?: string
  language?: Language
  range?: Range
  /** Non-blank lines; summed for components. */
  loc?: number
  /** Cyclomatic complexity; the maximum of the descendants for modules and components. */
  complexity?: number
  exported?: boolean
  /** Policy layer; a component has one only when every module inside shares it. */
  layer?: string
}

export type EdgeKind = 'import' | 'call'

export interface ModelEdge {
  from: string
  to: string
  kind: EdgeKind
  typeOnly?: boolean
  /** An inner layer depends on an outer one. */
  violation?: boolean
  /** Call-site lines in the caller's module. */
  lines?: number[]
}

export interface Model {
  /** Repo folder name. */
  name: string
  /** Absolute repo path. */
  root: string
  rootId: string
  generatedAt: string
  nodes: Record<string, ModelNode>
  edges: ModelEdge[]
  /** Layer names, outermost first. */
  layers: string[]
  warnings: string[]
}

export function isContainer(node: ModelNode): boolean {
  return node.children.length > 0
}

/** Ids from the root down to `id`, inclusive. */
export function pathTo(model: Model, id: string): string[] {
  const path: string[] = []
  for (let cur: string | null = id; cur !== null; cur = model.nodes[cur]?.parent ?? null) {
    path.unshift(cur)
  }
  return path
}

/** The nearest ancestor-or-self that exists in the model, falling back to the root. */
export function nearestNode(model: Model, id: string): string {
  if (model.nodes[id]) return id
  const hash = id.indexOf('#')
  if (hash !== -1) {
    const member = id.slice(hash + 1).split('.')
    while (member.length > 1) {
      member.pop()
      const candidate = id.slice(0, hash + 1) + member.join('.')
      if (model.nodes[candidate]) return candidate
    }
    return nearestNode(model, id.slice(0, hash))
  }
  const parts = id.replace(/\/$/, '').split('/')
  while (parts.length > 0) {
    parts.pop()
    const candidate = parts.length > 0 ? parts.join('/') + '/' : '/'
    if (model.nodes[candidate]) return candidate
  }
  return model.rootId
}
