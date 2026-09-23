import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import ELK from 'elkjs/lib/elk.bundled.js'

import type { Model, ModelNode } from '../core/model.ts'
import type { View, ViewNode } from '../core/view.ts'
import { countModules, footer, nodeLabel } from './labels.ts'

/** Box geometry shared by the layout and the node renderer, so ELK routes to real edges. */
export const BOX = {
  header: 30,
  item: 18,
  footer: 24,
  pad: 6,
  maxItems: 10,
  minWidth: 170,
  maxWidth: 320,
  ghostHeight: 46,
}

export interface Point {
  x: number
  y: number
}

export interface Placed {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface Layout {
  nodes: Placed[]
  edges: Map<string, Point[]>
  direction: 'DOWN' | 'RIGHT'
  width: number
  height: number
}

/** Children listed inside a box, capped; the renderer shows `+N more` for the rest. */
export function boxItems(model: Model, node: ModelNode): { names: ModelNode[]; more: number } {
  const children = node.children.map((id) => model.nodes[id]!).filter(Boolean)
  return {
    names: children.slice(0, BOX.maxItems),
    more: Math.max(0, children.length - BOX.maxItems),
  }
}

function boxSize(model: Model, vn: ViewNode): { width: number; height: number } {
  const node = model.nodes[vn.id]!
  const clamp = (w: number) => Math.min(BOX.maxWidth, Math.max(BOX.minWidth, Math.ceil(w)))
  if (vn.ghost) {
    const label = nodeLabel(model, vn.id).name
    return { width: clamp(label.length * 7.5 + 50), height: BOX.ghostHeight }
  }
  const { names, more } = boxItems(model, node)
  const longest = Math.max(0, ...names.map((n) => n.name.length))
  const lines = names.length + (more > 0 ? 1 : 0)
  const footerWidth = footer(node, countModules(model, vn.id)).length * 6.4 + 24
  const badgeWidth = node.complexity === undefined ? 0 : 58
  return {
    width: clamp(Math.max(node.name.length * 7.8 + 70, longest * 7 + 44, footerWidth + badgeWidth)),
    height: BOX.header + (lines > 0 ? lines * BOX.item + BOX.pad * 2 : 0) + BOX.footer,
  }
}

const elk = new ELK()

/**
 * Lay the level out top-down and left-to-right and keep whichever fits the viewport at the
 * larger zoom: a deep dependency chain reads better sideways on a wide screen.
 */
export async function layoutView(
  model: Model,
  view: View,
  viewport: { width: number; height: number },
): Promise<Layout> {
  const [down, right] = await Promise.all([
    layoutDirected(model, view, 'DOWN'),
    layoutDirected(model, view, 'RIGHT'),
  ])
  const fit = (l: Layout) => Math.min(viewport.width / l.width, viewport.height / l.height)
  return fit(right) > fit(down) * 1.15 ? right : down
}

async function layoutDirected(
  model: Model,
  view: View,
  direction: 'DOWN' | 'RIGHT',
): Promise<Layout> {
  const graph: ElkNode = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '36',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.edgeNode': '18',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.aspectRatio': '1.8',
    },
    children: view.nodes.map((vn) => ({ id: vn.id, ...boxSize(model, vn) })),
    edges: view.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  })

  const nodes: Placed[] = (graph.children ?? []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? BOX.minWidth,
    height: c.height ?? BOX.header,
  }))
  const edges = new Map<string, Point[]>()
  for (const e of (graph.edges ?? []) as ElkExtendedEdge[]) {
    const section = e.sections?.[0]
    if (section)
      edges.set(e.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint])
  }
  return { nodes, edges, direction, width: graph.width ?? 1, height: graph.height ?? 1 }
}
