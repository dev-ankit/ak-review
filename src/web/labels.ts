import type { Model, ModelNode } from '../core/model.ts'

const moduleCounts = new WeakMap<Model, Map<string, number>>()

/** Modules at or below a node (1 for a module, 0 for a symbol). */
export function countModules(model: Model, id: string): number {
  let counts = moduleCounts.get(model)
  if (!counts) moduleCounts.set(model, (counts = new Map()))
  const cached = counts.get(id)
  if (cached !== undefined) return cached
  const node = model.nodes[id]
  let n = 0
  if (node?.kind === 'module') n = 1
  else if (node?.kind === 'component') {
    for (const child of node.children) n += countModules(model, child)
  }
  counts.set(id, n)
  return n
}

/** Readable name for any node id: symbols as `Class.method` with their file. */
export function nodeLabel(model: Model, id: string): { name: string; where: string } {
  const node = model.nodes[id]
  const hash = id.indexOf('#')
  if (hash !== -1) {
    return { name: id.slice(hash + 1), where: id.slice(0, hash) }
  }
  if (node?.kind === 'module') {
    const slash = id.lastIndexOf('/')
    return { name: id.slice(slash + 1), where: id.slice(0, slash + 1) }
  }
  return { name: id === '/' ? (model.name ?? '/') : id, where: '' }
}

/** One-line label: full path for modules and components, `Class.method` for symbols. */
export function shortLabel(model: Model, id: string): string {
  const { name, where } = nodeLabel(model, id)
  return id.includes('#') ? name : where + name
}

/** Where a ghost node sits: a symbol's file, else its parent's id. */
export function ghostWhere(model: Model, id: string): string {
  const node = model.nodes[id]
  if (node?.file && node.kind !== 'module') return 'in ' + node.file
  const parent = node?.parent
  if (!parent) return 'outside'
  const p = model.nodes[parent]!
  return 'in ' + (p.kind === 'component' ? p.id : p.name)
}

/** Box footer summary; the layout sizes boxes from it too. */
export function footer(node: ModelNode, modules: number): string {
  const loc = node.loc ?? 0
  switch (node.kind) {
    case 'component':
      return `${modules} module${modules === 1 ? '' : 's'} · ${loc} loc`
    case 'module':
      return `${loc} loc`
    case 'class':
      return `${node.children.length} members · ${loc} lines`
    default:
      return `${loc} line${loc === 1 ? '' : 's'}`
  }
}
