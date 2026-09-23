import { create } from 'zustand'

import { type Model, nearestNode } from '../core/model.ts'

/** Focus is the node whose children fill the diagram; selection drives the inspector. */
interface ReviewState {
  model: Model | undefined
  status: string
  focus: string
  selected: string | undefined
  selectedEdge: string | undefined
  /** Node whose source is open in the bottom panel. */
  source: string | undefined
  setModel: (model: Model) => void
  setStatus: (status: string) => void
  focusOn: (id: string, select?: string) => void
  up: () => void
  select: (id: string | undefined) => void
  selectEdge: (id: string | undefined) => void
  /** Show a node wherever it lives: focus its parent and select it. */
  reveal: (id: string) => void
  openSource: (id: string | undefined) => void
}

const hash = new URLSearchParams(location.hash.slice(1))

export const useReview = create<ReviewState>()((set, get) => ({
  model: undefined,
  status: 'loading',
  focus: hash.get('focus') ?? '',
  selected: hash.get('sel') ?? undefined,
  selectedEdge: undefined,
  source: undefined,
  setModel: (model) => {
    const { focus, selected, source } = get()
    set({
      model,
      status: '',
      focus: nearestNode(model, focus || model.rootId),
      selected: selected && model.nodes[selected] ? selected : undefined,
      source: source && model.nodes[source] ? source : undefined,
    })
  },
  setStatus: (status) => set({ status }),
  focusOn: (id, select) => set({ focus: id, selected: select, selectedEdge: undefined }),
  up: () => {
    const { model, focus } = get()
    const parent = model?.nodes[focus]?.parent
    if (parent) set({ focus: parent, selected: focus, selectedEdge: undefined })
  },
  select: (id) => set({ selected: id, selectedEdge: undefined }),
  selectEdge: (id) => set({ selectedEdge: id, selected: undefined }),
  reveal: (id) => {
    const parent = get().model?.nodes[id]?.parent
    if (parent) set({ focus: parent, selected: id, selectedEdge: undefined })
  },
  openSource: (id) => set({ source: id }),
}))

// Keep focus and selection in the URL so a reload returns to the same place.
useReview.subscribe(({ focus, selected }) => {
  const params = new URLSearchParams()
  if (focus) params.set('focus', focus)
  if (selected) params.set('sel', selected)
  history.replaceState(null, '', '#' + params.toString())
})
