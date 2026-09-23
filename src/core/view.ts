import type { EdgeKind, Model, ModelEdge } from './model.ts'

/**
 * One level of the diagram: the children of a focus node, plus ghost nodes standing in for
 * whatever outside the focus they depend on (or that depends on them). Leaf edges are lifted
 * to that level and bundled, so one arrow may carry many `from -> to` pairs.
 */

export interface ViewNode {
  id: string
  /** Outside the focus; shown only because an edge touches it. */
  ghost: boolean
}

export interface ViewEdge {
  id: string
  from: string
  to: string
  pairs: ModelEdge[]
  violation: boolean
  /** Both ends sit in the same dependency cycle at this level. */
  cycle: boolean
  typeOnly: boolean
}

export interface View {
  focus: string
  edgeKind: EdgeKind
  nodes: ViewNode[]
  edges: ViewEdge[]
}

/** Components show module imports; inside a module or class the arrows are calls. */
export function edgeKindFor(model: Model, focus: string): EdgeKind {
  return model.nodes[focus]?.kind === 'component' ? 'import' : 'call'
}

export function computeView(model: Model, focus: string): View {
  const edgeKind = edgeKindFor(model, focus)
  const focusAncestors = new Set<string>()
  for (let cur: string | null = focus; cur !== null; cur = model.nodes[cur]?.parent ?? null) {
    focusAncestors.add(cur)
  }

  /**
   * The node at this level that stands for `id`, or null when it is the focus or above it.
   * Outside the focus, imports lift to the sibling branch they live in (`src/model/`), while
   * calls keep the exact caller or callee (`Store.add`): at call level that is the point.
   */
  const lift = (id: string): ViewNode | null => {
    if (!model.nodes[id] || focusAncestors.has(id)) return null
    let cur = id
    for (;;) {
      const parent = model.nodes[cur]!.parent
      if (parent === focus) return { id: cur, ghost: false }
      if (parent === null) return null
      if (focusAncestors.has(parent)) return { id: edgeKind === 'call' ? id : cur, ghost: true }
      cur = parent
    }
  }

  const nodes = new Map<string, ViewNode>()
  for (const child of model.nodes[focus]?.children ?? [])
    nodes.set(child, { id: child, ghost: false })

  const bundles = new Map<string, ViewEdge>()
  for (const edge of model.edges) {
    if (edge.kind !== edgeKind) continue
    const from = lift(edge.from)
    const to = lift(edge.to)
    if (!from || !to || from.id === to.id || (from.ghost && to.ghost)) continue
    if (from.ghost) nodes.set(from.id, from)
    if (to.ghost) nodes.set(to.id, to)
    const key = from.id + ' -> ' + to.id
    let bundle = bundles.get(key)
    if (!bundle) {
      bundle = {
        id: key,
        from: from.id,
        to: to.id,
        pairs: [],
        violation: false,
        cycle: false,
        typeOnly: true,
      }
      bundles.set(key, bundle)
    }
    bundle.pairs.push(edge)
    bundle.violation ||= edge.violation === true
    bundle.typeOnly &&= edge.typeOnly === true
  }

  const edges = [...bundles.values()]
  const inner = edges.filter(
    (e) => !nodes.get(e.from)!.ghost && !nodes.get(e.to)!.ghost && !e.typeOnly,
  )
  const component = stronglyConnected(
    [...nodes.values()].filter((n) => !n.ghost).map((n) => n.id),
    inner,
  )
  for (const edge of inner) {
    const c = component.get(edge.from)
    edge.cycle = c !== undefined && c === component.get(edge.to)
  }

  return { focus, edgeKind, nodes: [...nodes.values()], edges }
}

/**
 * Tarjan's algorithm. Maps each node that belongs to a cycle (an SCC with more than one
 * member) to its component index.
 */
export function stronglyConnected(
  ids: string[],
  edges: { from: string; to: string }[],
): Map<string, number> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) out.get(e.from)?.push(e.to)

  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result = new Map<string, number>()
  let counter = 0
  let componentCount = 0

  const visit = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const members: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        members.push(w)
      } while (w !== v)
      if (members.length > 1) {
        for (const m of members) result.set(m, componentCount)
        componentCount++
      }
    }
  }

  for (const id of ids) if (!index.has(id)) visit(id)
  return result
}
