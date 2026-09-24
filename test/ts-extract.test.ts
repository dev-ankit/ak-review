import { describe, expect, it } from 'vitest'

import type { IrSymbol } from '../src/core/ir.ts'
import { layeredIr } from './fixture.ts'

const ir = await layeredIr()
const mod = (id: string) => ir.modules.find((m) => m.id === id)!
const calls = (from: string) =>
  ir.calls
    .filter((c) => c.from === from)
    .map((c) => c.to)
    .sort()
const summarize = (s: IrSymbol): unknown => ({
  name: s.name,
  kind: s.kind,
  ...(s.complexity !== undefined && { cc: s.complexity }),
  ...(s.children && { children: s.children.map(summarize) }),
})

describe('typescript extractor', () => {
  it('finds tsconfig sources and loose files outside any config', () => {
    expect(ir.modules.map((m) => m.id)).toEqual([
      'scripts/tool.js',
      'src/lib/reexport.ts',
      'src/model/store.ts',
      'src/model/types.ts',
      'src/ui/App.tsx',
      'src/ui/format.ts',
    ])
    expect(mod('scripts/tool.js').language).toBe('javascript')
    expect(mod('src/ui/App.tsx').language).toBe('typescript')
    expect(ir.warnings).toEqual([])
  })

  it('extracts top-level symbols and class members with complexity', () => {
    expect(mod('src/model/store.ts').symbols.map(summarize)).toEqual([
      {
        name: 'Store',
        kind: 'class',
        children: [
          { name: 'add', kind: 'method', cc: 2 },
          { name: 'find', kind: 'method', cc: 1 },
          { name: 'label', kind: 'method', cc: 2 },
        ],
      },
      { name: 'createStore', kind: 'function', cc: 1 },
    ])
    expect(mod('src/ui/format.ts').symbols[0]).toMatchObject({
      id: 'src/ui/format.ts#formatName',
      exported: true,
      complexity: 3,
      range: { start: 1, end: 3 },
    })
    expect(mod('src/model/types.ts').symbols.map((s) => s.kind)).toEqual(['interface', 'type'])
    expect(mod('src/ui/App.tsx').symbols.map((s) => `${s.name}:${s.kind}`)).toEqual([
      'store:variable',
      'Title:function',
      'App:function',
    ])
  })

  it('resolves imports, marking type-only ones, and records external packages', () => {
    const edges = ir.imports.map((e) => `${e.from} -> ${e.to}${e.typeOnly ? ' (type)' : ''}`)
    expect(edges.sort()).toEqual([
      'src/lib/reexport.ts -> src/ui/format.ts',
      'src/model/store.ts -> src/model/types.ts (type)',
      'src/model/store.ts -> src/ui/format.ts',
      'src/ui/App.tsx -> src/lib/reexport.ts',
      'src/ui/App.tsx -> src/model/store.ts',
      'src/ui/App.tsx -> src/ui/format.ts',
    ])
    expect(mod('src/ui/App.tsx').externals).toEqual(['react'])
  })

  it('resolves calls through aliases, namespaces, re-exports, new, and JSX', () => {
    expect(calls('src/ui/App.tsx#App')).toEqual([
      'src/model/store.ts#Store.add',
      'src/ui/App.tsx#Title',
      'src/ui/format.ts#formatName',
    ])
    const toFormat = ir.calls.find(
      (c) => c.from === 'src/ui/App.tsx#App' && c.to === 'src/ui/format.ts#formatName',
    )
    expect(toFormat?.lines).toEqual([20, 21, 22])
    expect(calls('src/ui/App.tsx#store')).toEqual(['src/model/store.ts#createStore'])
    expect(calls('src/model/store.ts#createStore')).toEqual(['src/model/store.ts#Store'])
    expect(calls('src/model/store.ts#Store.label')).toEqual([
      'src/model/store.ts#Store.find',
      'src/ui/format.ts#formatName',
    ])
    expect(calls('src/ui/App.tsx#Title')).toEqual(['src/model/store.ts#Store.label'])
    expect(calls('scripts/tool.js')).toEqual(['scripts/tool.js#main'])
  })
})
