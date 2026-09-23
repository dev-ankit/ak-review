import { ReactFlowProvider } from '@xyflow/react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useMemo } from 'react'

import { type Model, pathTo } from '../core/model.ts'
import { computeView } from '../core/view.ts'
import { fetchModel, refresh, subscribe } from './api.ts'
import { Diagram } from './Diagram.tsx'
import { Inspector } from './Inspector.tsx'
import { SourcePanel } from './SourcePanel.tsx'
import { useReview } from './store.ts'

export function App() {
  const model = useReview((s) => s.model)
  const status = useReview((s) => s.status)

  useEffect(() => {
    const { setModel, setStatus } = useReview.getState()
    const load = () =>
      fetchModel().then(setModel, (e: Error) => setStatus(`waiting for server: ${e.message}`))
    load()
    return subscribe(load, setStatus)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement) return
      const s = useReview.getState()
      if (s.source) s.openSource(undefined)
      else if (s.selected || s.selectedEdge) s.select(undefined)
      else s.up()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!model) return <div className="splash">{status || 'loading'}…</div>
  return <Review model={model} status={status} />
}

function Review({ model, status }: { model: Model; status: string }) {
  const focus = useReview((s) => s.focus)
  const source = useReview((s) => s.source)
  const view = useMemo(() => computeView(model, focus), [model, focus])
  const moduleCount = useMemo(
    () => Object.values(model.nodes).filter((n) => n.kind === 'module').length,
    [model],
  )
  const violations = useMemo(
    () => model.edges.filter((e) => e.violation && e.kind === 'import').length,
    [model],
  )

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">ak-review</span>
        <nav className="crumbs">
          {pathTo(model, focus).map((id, i, all) => (
            <span key={id} className="crumb">
              {i > 0 && <ChevronRight size={14} className="muted" />}
              <button
                className={i === all.length - 1 ? 'current' : ''}
                onClick={() => useReview.getState().focusOn(id)}
              >
                {i === 0 ? rootLabel(model) : model.nodes[id]!.name}
              </button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        {status && <span className="status">{status}…</span>}
        <span className="stat">{moduleCount} modules</span>
        {model.layers.length > 0 && (
          <span className={`stat${violations ? ' violation' : ''}`}>
            {violations} layer violation{violations === 1 ? '' : 's'}
          </span>
        )}
        <button className="icon" title="Re-extract" onClick={() => refresh()}>
          <RefreshCw size={16} />
        </button>
      </header>
      <main className="workspace">
        <div className="stage">
          <ReactFlowProvider>
            <Diagram model={model} view={view} />
          </ReactFlowProvider>
          {source && <SourcePanel model={model} id={source} />}
        </div>
        <Inspector model={model} view={view} />
      </main>
    </div>
  )
}

/** `architorio/src` when the model's root collapsed into a single top-level directory. */
function rootLabel(model: Model): string {
  return model.rootId === '/' ? model.name : `${model.name}/${model.rootId.replace(/\/$/, '')}`
}
