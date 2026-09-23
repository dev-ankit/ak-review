import {
  Background,
  Controls,
  type EdgeMouseHandler,
  MarkerType,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { Model } from '../core/model.ts'
import type { View, ViewEdge } from '../core/view.ts'
import { BoxNode, type BoxNodeType } from './BoxNode.tsx'
import { countModules, ghostWhere, nodeLabel, shortLabel } from './labels.ts'
import { boxItems, type Layout, layoutView } from './layout.ts'
import { edgeClass, RoutedEdge, type RoutedEdgeType } from './RoutedEdge.tsx'
import { useReview } from './store.ts'

const nodeTypes = { box: BoxNode }
const edgeTypes = { routed: RoutedEdge }

const EDGE_COLOR: Record<string, string> = {
  violation: '#ff5c7a',
  cycle: '#ffa53d',
  'type-only': '#5c667a',
  plain: '#7d8aa3',
}

interface Hover {
  edge: ViewEdge
  x: number
  y: number
}

export function Diagram({ model, view }: { model: Model; view: View }) {
  const selected = useReview((s) => s.selected)
  const selectedEdge = useReview((s) => s.selectedEdge)
  const { select, selectEdge, focusOn, reveal, openSource } = useReview.getState()
  const { fitView } = useReactFlow()
  const [laid, setLaid] = useState<{ view: View; layout: Layout }>()
  const [hover, setHover] = useState<Hover>()
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const viewport = {
      width: container.current?.clientWidth || 1200,
      height: container.current?.clientHeight || 800,
    }
    layoutView(model, view, viewport).then((layout) => live && setLaid({ view, layout }))
    return () => {
      live = false
    }
  }, [model, view])

  useEffect(() => {
    if (!laid) return
    const frame = requestAnimationFrame(() => fitView({ padding: 0.12, duration: 200 }))
    return () => cancelAnimationFrame(frame)
  }, [laid, fitView])

  const nodes = useMemo<BoxNodeType[]>(() => {
    if (!laid) return []
    const ghosts = new Set(laid.view.nodes.filter((n) => n.ghost).map((n) => n.id))
    // The model can be newer than the layout for a frame; skip nodes it no longer has.
    return laid.layout.nodes.flatMap((p): BoxNodeType[] => {
      const node = model.nodes[p.id]
      if (!node) return []
      const ghost = ghosts.has(p.id)
      const { names, more } = boxItems(model, node)
      const box: BoxNodeType = {
        id: p.id,
        type: 'box',
        position: { x: p.x, y: p.y },
        width: p.width,
        height: p.height,
        draggable: false,
        selected: p.id === selected,
        data: {
          node,
          ghost,
          items: ghost ? [] : names,
          more,
          modules: countModules(model, p.id),
          where: ghost ? ghostWhere(model, p.id) : undefined,
          label: ghost ? nodeLabel(model, p.id).name : node.name,
        },
      }
      return [box]
    })
  }, [laid, model, selected])

  const edges = useMemo<RoutedEdgeType[]>(() => {
    if (!laid) return []
    return laid.view.edges.map((e) => {
      const cls = edgeClass(e)
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'routed',
        selected: e.id === selectedEdge,
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[cls], width: 16, height: 16 },
        data: {
          points: laid.layout.edges.get(e.id) ?? [],
          count: e.pairs.length,
          violation: e.violation,
          cycle: e.cycle,
          typeOnly: e.typeOnly,
          dim: selected !== undefined && e.from !== selected && e.to !== selected,
        },
      }
    })
  }, [laid, selected, selectedEdge])

  const byId = useMemo(() => new Map(view.edges.map((e) => [e.id, e])), [view])
  const onEdgeHover: EdgeMouseHandler = (event, edge) => {
    const viewEdge = byId.get(edge.id)
    if (viewEdge) setHover({ edge: viewEdge, x: event.clientX, y: event.clientY })
  }

  return (
    <div className="diagram" ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        onNodeClick={(_, n) => select(n.id)}
        onNodeDoubleClick={(_, n) => {
          const node = model.nodes[n.id]!
          if ((n.data as BoxNodeType['data']).ghost) reveal(n.id)
          else if (node.children.length > 0) focusOn(n.id)
          else openSource(n.id)
        }}
        onEdgeClick={(_, e) => selectEdge(e.id)}
        onEdgeMouseEnter={onEdgeHover}
        onEdgeMouseMove={onEdgeHover}
        onEdgeMouseLeave={() => setHover(undefined)}
        onPaneClick={() => select(undefined)}
      >
        <Background gap={24} size={1} color="var(--grid)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {laid && view.nodes.length === 0 && (
        <div className="empty">
          Nothing to show here. Check <code>include</code>/<code>exclude</code> in
          .ak-review/policy.yaml.
        </div>
      )}
      {hover && <EdgeTooltip model={model} hover={hover} />}
    </div>
  )
}

const TOOLTIP_PAIRS = 14

function EdgeTooltip({ model, hover }: { model: Model; hover: Hover }) {
  const { edge } = hover
  const pairs = edge.pairs.slice(0, TOOLTIP_PAIRS)
  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
      <div className="tooltip-title">
        {model.nodes[edge.from]?.name} → {model.nodes[edge.to]?.name}
        <span className="muted">
          {' '}
          · {edge.pairs.length} {edge.pairs[0]?.kind === 'call' ? 'calls' : 'imports'}
          {edge.violation && ' · layer violation'}
          {edge.cycle && ' · in a cycle'}
        </span>
      </div>
      {pairs.map((p) => (
        <div key={p.from + p.to} className={`pair${p.violation ? ' violation' : ''}`}>
          {shortLabel(model, p.from)} → {shortLabel(model, p.to)}
          {p.typeOnly && <span className="muted"> (type)</span>}
        </div>
      ))}
      {edge.pairs.length > TOOLTIP_PAIRS && (
        <div className="muted">+{edge.pairs.length - TOOLTIP_PAIRS} more — click the arrow</div>
      )}
    </div>
  )
}
