import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

import type { Point } from './layout.ts'

export interface RoutedData extends Record<string, unknown> {
  points: Point[]
  count: number
  violation: boolean
  cycle: boolean
  typeOnly: boolean
  dim: boolean
}

export type RoutedEdgeType = Edge<RoutedData, 'routed'>

export function edgeClass(d: { violation: boolean; cycle: boolean; typeOnly: boolean }): string {
  return d.violation ? 'violation' : d.cycle ? 'cycle' : d.typeOnly ? 'type-only' : 'plain'
}

/** Midpoint along the polyline, for the bundle count. */
function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]!) {
      const t = lengths[i] === 0 ? 0 : remaining / lengths[i]!
      const a = points[i]!
      const b = points[i + 1]!
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    remaining -= lengths[i]!
  }
  return points[0]!
}

/** Draws the orthogonal route ELK computed instead of React Flow's own path. */
export function RoutedEdge({ id, data, markerEnd, selected }: EdgeProps<RoutedEdgeType>) {
  if (!data || data.points.length < 2) return null
  const path = data.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const mid = midpoint(data.points)
  const cls = `routed ${edgeClass(data)}${data.dim ? ' dim' : ''}${selected ? ' selected' : ''}`
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} interactionWidth={14} />
      {data.count > 1 && (
        <EdgeLabelRenderer>
          <div
            className={`edge-count ${cls}`}
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
          >
            {data.count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
