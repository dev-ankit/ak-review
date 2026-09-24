import { describe, expect, it } from 'vitest'

import { computeView, stronglyConnected } from '../src/core/view.ts'
import { buildModel } from '../src/server/build-model.ts'
import { DEFAULT_POLICY } from '../src/server/policy.ts'
import { layeredIr } from './fixture.ts'

const model = buildModel(await layeredIr(), { ...DEFAULT_POLICY, exclude: ['scripts/**'] })
const edgeIds = (focus: string) =>
  computeView(model, focus)
    .edges.map((e) => `${e.from} -> ${e.to}${e.cycle ? ' (cycle)' : ''}`)
    .sort()
const ghosts = (focus: string) =>
  computeView(model, focus)
    .nodes.filter((n) => n.ghost)
    .map((n) => n.id)
    .sort()

describe('computeView', () => {
  it('bundles module imports between components and marks cycles', () => {
    const view = computeView(model, 'src/')
    expect(view.edgeKind).toBe('import')
    expect(view.nodes).toEqual([
      { id: 'src/lib/', ghost: false },
      { id: 'src/model/', ghost: false },
      { id: 'src/ui/', ghost: false },
    ])
    expect(edgeIds('src/')).toEqual([
      'src/lib/ -> src/ui/ (cycle)',
      'src/model/ -> src/ui/ (cycle)',
      'src/ui/ -> src/lib/ (cycle)',
      'src/ui/ -> src/model/ (cycle)',
    ])
    const uiToModel = view.edges.find((e) => e.id === 'src/ui/ -> src/model/')!
    expect(uiToModel.pairs.map((p) => p.from + ' -> ' + p.to)).toEqual([
      'src/ui/App.tsx -> src/model/store.ts',
    ])
  })

  it('shows outside dependencies of a component as ghost sibling branches', () => {
    expect(ghosts('src/ui/')).toEqual(['src/lib/', 'src/model/'])
    expect(edgeIds('src/ui/')).toEqual([
      'src/lib/ -> src/ui/format.ts',
      'src/model/ -> src/ui/format.ts',
      'src/ui/App.tsx -> src/lib/',
      'src/ui/App.tsx -> src/model/',
      'src/ui/App.tsx -> src/ui/format.ts',
    ])
  })

  it('switches to calls inside a module, with outside callees as exact ghosts', () => {
    expect(computeView(model, 'src/ui/App.tsx').edgeKind).toBe('call')
    expect(ghosts('src/ui/App.tsx')).toEqual([
      'src/model/store.ts#Store.add',
      'src/model/store.ts#Store.label',
      'src/model/store.ts#createStore',
      'src/ui/format.ts#formatName',
    ])
    expect(edgeIds('src/ui/App.tsx')).toContain('src/ui/App.tsx#App -> src/ui/App.tsx#Title')
  })

  it('shows callers from outside when focused on a class', () => {
    expect(edgeIds('src/model/store.ts#Store')).toEqual([
      'src/model/store.ts#Store.label -> src/model/store.ts#Store.find',
      'src/model/store.ts#Store.label -> src/ui/format.ts#formatName',
      'src/ui/App.tsx#App -> src/model/store.ts#Store.add',
      'src/ui/App.tsx#Title -> src/model/store.ts#Store.label',
    ])
    expect(ghosts('src/model/store.ts#Store')).toContain('src/ui/App.tsx#Title')
  })
})

describe('stronglyConnected', () => {
  it('only reports components with more than one member', () => {
    const scc = stronglyConnected(
      ['a', 'b', 'c', 'd'],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'b', to: 'c' },
        { from: 'd', to: 'd' },
      ],
    )
    expect(scc.get('a')).toBe(scc.get('b'))
    expect(scc.has('c')).toBe(false)
    expect(scc.has('d')).toBe(false)
  })
})
