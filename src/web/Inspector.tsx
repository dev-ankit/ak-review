import { Code, CornerDownRight, TriangleAlert } from 'lucide-react'

import type { Model, ModelEdge } from '../core/model.ts'
import type { View, ViewEdge } from '../core/view.ts'
import { complexityClass } from './BoxNode.tsx'
import { KIND_LABEL, KindIcon } from './kinds.tsx'
import { countModules, shortLabel } from './labels.ts'
import { useReview } from './store.ts'

/** Right-hand panel: the selected node or arrow, or a summary of the current level. */
export function Inspector({ model, view }: { model: Model; view: View }) {
  const selected = useReview((s) => s.selected)
  const selectedEdge = useReview((s) => s.selectedEdge)
  const edge = selectedEdge ? view.edges.find((e) => e.id === selectedEdge) : undefined
  return (
    <aside className="inspector">
      {edge ? (
        <EdgeDetails model={model} edge={edge} />
      ) : selected && model.nodes[selected] ? (
        <NodeDetails model={model} view={view} id={selected} />
      ) : (
        <LevelSummary model={model} view={view} />
      )}
    </aside>
  )
}

function NodeRef({ model, id, className }: { model: Model; id: string; className?: string }) {
  const node = model.nodes[id]
  if (!node) return <span className="muted">{id}</span>
  return (
    <button
      className={`node-ref ${className ?? ''}`}
      onClick={() => useReview.getState().reveal(id)}
      title={id}
    >
      <KindIcon kind={node.kind} size={12} />
      <span>{shortLabel(model, id)}</span>
    </button>
  )
}

function NodeDetails({ model, view, id }: { model: Model; view: View; id: string }) {
  const node = model.nodes[id]!
  const { focusOn, openSource } = useReview.getState()
  const outgoing = view.edges.filter((e) => e.from === id)
  const incoming = view.edges.filter((e) => e.to === id)
  const noun = view.edgeKind === 'import' ? 'imports' : 'calls'
  return (
    <>
      <header className="inspector-head">
        <KindIcon kind={node.kind} size={18} />
        <div>
          <h2>{node.name}</h2>
          <div className="muted mono">{node.id}</div>
        </div>
      </header>
      <div className="facts">
        <span className="badge">{KIND_LABEL[node.kind]}</span>
        {node.language && <span className="badge">{node.language}</span>}
        {node.layer && <span className="badge layer">layer: {node.layer}</span>}
        {node.exported && <span className="badge">exported</span>}
        {node.kind === 'component' && (
          <span className="badge">{countModules(model, id)} modules</span>
        )}
        {node.loc !== undefined && <span className="badge">{node.loc} loc</span>}
        {node.complexity !== undefined && (
          <span className={`badge ${complexityClass(node.complexity)}`}>CC {node.complexity}</span>
        )}
      </div>
      <div className="actions">
        {node.children.length > 0 && (
          <button onClick={() => focusOn(id)}>
            <CornerDownRight size={14} /> Open
          </button>
        )}
        {node.file && (
          <button onClick={() => openSource(id)}>
            <Code size={14} /> Source
          </button>
        )}
      </div>
      <EdgeList model={model} title={`Depends on (${noun})`} edges={outgoing} end="to" />
      <EdgeList model={model} title={`Used by (${noun})`} edges={incoming} end="from" />
      {node.children.length > 0 && (
        <section>
          <h3>Contains ({node.children.length})</h3>
          {node.children.map((child) => (
            <NodeRef key={child} model={model} id={child} />
          ))}
        </section>
      )}
    </>
  )
}

function EdgeList(props: { model: Model; title: string; edges: ViewEdge[]; end: 'from' | 'to' }) {
  const { model, title, edges, end } = props
  if (edges.length === 0) return null
  return (
    <section>
      <h3>{title}</h3>
      {edges.map((e) => (
        <div key={e.id} className="edge-row">
          <NodeRef
            model={model}
            id={e[end]}
            className={e.violation ? 'violation' : e.cycle ? 'cycle' : ''}
          />
          <button
            className="count"
            onClick={() => useReview.getState().selectEdge(e.id)}
            title="Show every pair"
          >
            {e.pairs.length}
          </button>
        </div>
      ))}
    </section>
  )
}

function EdgeDetails({ model, edge }: { model: Model; edge: ViewEdge }) {
  const violations = edge.pairs.filter((p) => p.violation)
  const rest = edge.pairs.filter((p) => !p.violation)
  return (
    <>
      <header className="inspector-head">
        <div>
          <h2>
            {model.nodes[edge.from]?.name} → {model.nodes[edge.to]?.name}
          </h2>
          <div className="muted">
            {edge.pairs.length} {edge.pairs[0]?.kind === 'call' ? 'calls' : 'imports'}
            {edge.typeOnly && ' · type-only'}
          </div>
        </div>
      </header>
      {edge.violation && (
        <p className="callout violation">
          <TriangleAlert size={14} /> An inner layer depends on an outer one.
        </p>
      )}
      {edge.cycle && (
        <p className="callout cycle">
          <TriangleAlert size={14} /> Both ends are in a dependency cycle at this level.
        </p>
      )}
      <PairList model={model} title="Violating" pairs={violations} />
      <PairList model={model} title={violations.length ? 'Other' : 'Pairs'} pairs={rest} />
    </>
  )
}

function PairList({ model, title, pairs }: { model: Model; title: string; pairs: ModelEdge[] }) {
  if (pairs.length === 0) return null
  return (
    <section>
      <h3>{title}</h3>
      {pairs.map((p) => (
        <div key={p.from + ' ' + p.to} className="pair-row">
          <NodeRef model={model} id={p.from} />
          <span className="arrow">→</span>
          <NodeRef model={model} id={p.to} />
          {p.lines && <span className="muted mono">L{p.lines.join(', ')}</span>}
        </div>
      ))}
    </section>
  )
}

function LevelSummary({ model, view }: { model: Model; view: View }) {
  const focus = model.nodes[view.focus]
  const violations = view.edges.filter((e) => e.violation)
  const cycles = view.edges.filter((e) => e.cycle)
  return (
    <>
      <header className="inspector-head">
        {focus && <KindIcon kind={focus.kind} size={18} />}
        <div>
          <h2>{focus?.name ?? model.name}</h2>
          <div className="muted">
            {view.nodes.filter((n) => !n.ghost).length} boxes · {view.edges.length} arrows (
            {view.edgeKind === 'import' ? 'imports' : 'calls'})
          </div>
        </div>
      </header>
      <p className="muted">
        Click a box or arrow to inspect it. Double-click a box to open it; Esc goes up a level.
      </p>
      {violations.length > 0 && (
        <section>
          <h3 className="violation">Layer violations ({violations.length})</h3>
          {violations.map((e) => (
            <EdgeLink key={e.id} model={model} edge={e} />
          ))}
        </section>
      )}
      {cycles.length > 0 && (
        <section>
          <h3 className="cycle">In cycles ({cycles.length})</h3>
          {cycles.map((e) => (
            <EdgeLink key={e.id} model={model} edge={e} />
          ))}
        </section>
      )}
      <section>
        <h3>Legend</h3>
        <div className="legend">
          <span className="swatch plain" /> dependency
          <span className="swatch violation" /> layer violation
          <span className="swatch cycle" /> cycle
          <span className="swatch type-only" /> type-only
        </div>
        {model.layers.length === 0 && (
          <p className="muted">
            No layers defined. Add <code>layers</code> to .ak-review/policy.yaml to check the
            dependency rule.
          </p>
        )}
      </section>
      {model.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          {model.warnings.map((w) => (
            <pre key={w} className="warning">
              {w}
            </pre>
          ))}
        </section>
      )}
    </>
  )
}

function EdgeLink({ model, edge }: { model: Model; edge: ViewEdge }) {
  return (
    <button className="node-ref" onClick={() => useReview.getState().selectEdge(edge.id)}>
      {model.nodes[edge.from]?.name} → {model.nodes[edge.to]?.name}
      <span className="muted"> ({edge.pairs.length})</span>
    </button>
  )
}
