import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'

import type { ModelNode } from '../core/model.ts'
import { KindIcon } from './kinds.tsx'
import { footer } from './labels.ts'
import { BOX } from './layout.ts'

export interface BoxData extends Record<string, unknown> {
  node: ModelNode
  ghost: boolean
  items: ModelNode[]
  more: number
  modules: number
  /** Where a ghost lives, relative to the focus. */
  where?: string
  /** Ghosts outside the module show `Class.method`, not just `method`. */
  label: string
}

export type BoxNodeType = Node<BoxData, 'box'>

export function complexityClass(cc: number | undefined): string {
  if (cc === undefined) return ''
  return cc > 20 ? 'cc-bad' : cc > 10 ? 'cc-warn' : 'cc-ok'
}

/** A component, module, class or function box listing what it contains. */
export function BoxNode({ data, selected, width, height }: NodeProps<BoxNodeType>) {
  const { node, ghost, items, more, modules, where, label } = data
  const handles = (
    <>
      <Handle type="target" position={Position.Top} className="handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="handle" isConnectable={false} />
    </>
  )
  if (ghost) {
    return (
      <div className={`box ghost${selected ? ' selected' : ''}`} style={{ width, height }}>
        {handles}
        <div className="box-header">
          <KindIcon kind={node.kind} />
          <span className="box-title">{label}</span>
        </div>
        <div className="box-where">{where}</div>
      </div>
    )
  }
  const cc = node.complexity
  return (
    <div
      className={`box kind-${node.kind}${selected ? ' selected' : ''}`}
      style={{ width, height }}
      title={node.id}
    >
      {handles}
      <div className="box-header" style={{ height: BOX.header }}>
        <KindIcon kind={node.kind} />
        <span className="box-title">{node.name}</span>
        {node.layer && <span className="badge layer">{node.layer}</span>}
      </div>
      {items.length > 0 && (
        <ul className="box-items" style={{ padding: `${BOX.pad}px 0` }}>
          {items.map((item) => (
            <li key={item.id} style={{ height: BOX.item }}>
              <KindIcon kind={item.kind} size={11} />
              <span>{item.name}</span>
            </li>
          ))}
          {more > 0 && (
            <li className="more" style={{ height: BOX.item }}>
              +{more} more
            </li>
          )}
        </ul>
      )}
      <div className="box-footer" style={{ height: BOX.footer }}>
        <span>{footer(node, modules)}</span>
        {cc !== undefined && (
          <span
            className={`badge ${complexityClass(cc)}`}
            title={node.kind === 'component' || node.kind === 'module' ? 'max complexity' : ''}
          >
            CC {cc}
          </span>
        )}
      </div>
    </div>
  )
}
