import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Model } from '../core/model.ts'
import { fetchSource } from './api.ts'
import { useReview } from './store.ts'

/** Bottom panel with the file of the open node; a symbol's lines are highlighted. */
export function SourcePanel({ model, id }: { model: Model; id: string }) {
  const node = model.nodes[id]
  const file = node?.file
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  const highlight = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!file) return
    let live = true
    setText(undefined)
    setError(undefined)
    fetchSource(file).then(
      (t) => live && setText(t),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [file, model.generatedAt])

  useEffect(() => {
    highlight.current?.scrollIntoView({ block: 'center' })
  }, [text, id])

  if (!node || !file) return null
  const range = node.range
  const lines = text?.split('\n') ?? []
  return (
    <section className="source">
      <header>
        <span className="mono">{file}</span>
        {range && (
          <span className="muted">
            {' '}
            · {node.name} L{range.start}–{range.end}
          </span>
        )}
        <button className="icon" onClick={() => useReview.getState().openSource(undefined)}>
          <X size={16} />
        </button>
      </header>
      <div className="source-body">
        {error && <div className="warning">{error}</div>}
        {lines.map((line, i) => {
          const n = i + 1
          const hit = range !== undefined && n >= range.start && n <= range.end
          return (
            <div
              key={n}
              ref={range?.start === n ? highlight : undefined}
              className={`line${hit ? ' hit' : ''}`}
            >
              <span className="ln">{n}</span>
              <code>{line || ' '}</code>
            </div>
          )
        })}
      </div>
    </section>
  )
}
