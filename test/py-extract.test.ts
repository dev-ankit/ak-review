import { describe, expect, it } from 'vitest'

import type { IrSymbol } from '../src/core/ir.ts'
import { ImportResolver, sourceRoots } from '../src/lang/py/imports.ts'
import { PYTHON_LAYERED, pythonLayeredIr } from './fixture.ts'

const ir = await pythonLayeredIr()
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

describe('python extractor', () => {
  it('finds every tracked .py file, packages included', () => {
    expect(ir.modules.map((m) => m.id)).toEqual([
      'scripts/tool.py',
      'src/shop/__init__.py',
      'src/shop/lib/__init__.py',
      'src/shop/model/__init__.py',
      'src/shop/model/store.py',
      'src/shop/model/types.py',
      'src/shop/ui/__init__.py',
      'src/shop/ui/app.py',
      'src/shop/ui/format.py',
    ])
    expect(mod('src/shop/ui/app.py').language).toBe('python')
    expect(ir.warnings).toEqual([])
  })

  it('extracts top-level symbols and class methods with complexity', () => {
    expect(mod('src/shop/model/store.py').symbols.map(summarize)).toEqual([
      {
        name: 'Store',
        kind: 'class',
        children: [
          { name: '__init__', kind: 'method', cc: 1 },
          { name: 'add', kind: 'method', cc: 2 },
          { name: 'find', kind: 'method', cc: 2 },
          { name: 'label', kind: 'method', cc: 2 },
        ],
      },
      // The nested `fill` belongs to create_store: its `for` and `or` count here.
      { name: 'create_store', kind: 'function', cc: 3 },
    ])
    expect(mod('src/shop/ui/format.py').symbols.map(summarize)).toEqual([
      { name: '_MAX', kind: 'variable' },
      { name: 'format_name', kind: 'function', cc: 3 },
      { name: 'shout', kind: 'function', cc: 1 },
      { name: 'fetch_name', kind: 'function', cc: 2 },
      { name: 'exclaim', kind: 'function', cc: 1 },
    ])
    expect(mod('src/shop/ui/format.py').symbols[1]).toMatchObject({
      id: 'src/shop/ui/format.py#format_name',
      exported: true,
      range: { start: 6, end: 7 },
    })
    // A decorated function's range starts at its decorator.
    expect(mod('src/shop/ui/format.py').symbols[2]!.range).toEqual({ start: 10, end: 12 })
  })

  it('exports names in __all__ when there is one, and non-underscore names otherwise', () => {
    const exported = (id: string) =>
      mod(id)
        .symbols.filter((s) => s.exported)
        .map((s) => s.name)
    expect(exported('src/shop/model/types.py')).toEqual(['Item'])
    expect(exported('src/shop/ui/format.py')).toEqual([
      'format_name',
      'shout',
      'fetch_name',
      'exclaim',
    ])
  })

  it('resolves absolute, relative and package imports, marking TYPE_CHECKING ones', () => {
    const edges = ir.imports.map((e) => `${e.from} -> ${e.to}${e.typeOnly ? ' (type)' : ''}`)
    expect(edges.sort()).toEqual([
      'scripts/tool.py -> src/shop/ui/format.py',
      'src/shop/lib/__init__.py -> src/shop/ui/format.py',
      'src/shop/model/store.py -> src/shop/model/types.py (type)',
      'src/shop/model/store.py -> src/shop/ui/format.py',
      'src/shop/ui/app.py -> src/shop/lib/__init__.py',
      'src/shop/ui/app.py -> src/shop/model/store.py',
      'src/shop/ui/app.py -> src/shop/model/types.py',
      'src/shop/ui/app.py -> src/shop/ui/format.py',
    ])
    expect(mod('src/shop/ui/app.py').externals).toEqual(['json'])
    // `from __future__` is not a dependency.
    expect(mod('src/shop/model/store.py').externals).toEqual(['typing'])
  })

  it('resolves calls through aliases, re-exports, constructors and inferred receivers', () => {
    expect(calls('src/shop/ui/app.py#App.render')).toEqual([
      'src/shop/model/store.py#Store.add',
      'src/shop/model/types.py#Item',
      'src/shop/ui/app.py#title',
      'src/shop/ui/format.py#format_name',
    ])
    const toFormat = ir.calls.find(
      (c) =>
        c.from === 'src/shop/ui/app.py#App.render' && c.to === 'src/shop/ui/format.py#format_name',
    )
    // fmt.format_name, format_name, and fmt_name re-exported from shop.lib.
    expect(toFormat?.lines).toEqual([23, 24, 25])
    expect(calls('src/shop/ui/app.py#store')).toEqual(['src/shop/model/store.py#create_store'])
    expect(calls('src/shop/ui/app.py#title')).toEqual(['src/shop/model/store.py#Store.label'])
    expect(calls('src/shop/model/store.py#Store.label')).toEqual([
      'src/shop/model/store.py#Store.find',
      'src/shop/ui/format.py#format_name',
    ])
    // Calls in a nested function belong to the enclosing one.
    expect(calls('src/shop/model/store.py#create_store')).toEqual([
      'src/shop/model/store.py#Store',
      'src/shop/model/store.py#Store.add',
    ])
    expect(calls('src/shop/ui/format.py#exclaim')).toEqual(['src/shop/ui/format.py#shout'])
    expect(calls('scripts/tool.py')).toEqual(['scripts/tool.py#main'])
    expect(calls('scripts/tool.py#main')).toEqual(['src/shop/ui/format.py#format_name'])
  })
})

describe('python import resolution', () => {
  const modules = [
    'app/__init__.py',
    'app/core.py',
    'app/sub/deep.py',
    'ns/mod.py',
    'lib/src/pkg/__init__.py',
    'lib/src/pkg/util.py',
  ]
  const resolver = new ImportResolver(modules, ['lib/src', ''])
  const resolve = (from: string, level: number, module: string[], names?: string[]) =>
    resolver.resolve(from, { level, module, names, typeOnly: false })

  it('binds the deepest existing module, and submodules named in from-imports', () => {
    expect(resolve('x.py', 0, ['app', 'core', 'missing'])).toEqual({ targets: ['app/core.py'] })
    expect(resolve('x.py', 0, ['app'], ['core', 'VERSION'])).toEqual({
      targets: ['app/core.py', 'app/__init__.py'],
    })
    expect(resolve('x.py', 0, ['pkg', 'util'])).toEqual({ targets: ['lib/src/pkg/util.py'] })
  })

  it('handles namespace packages, relative imports and third-party packages', () => {
    expect(resolve('x.py', 0, ['ns'], ['mod'])).toEqual({ targets: ['ns/mod.py'] })
    expect(resolve('app/sub/deep.py', 2, [], ['core'])).toEqual({ targets: ['app/core.py'] })
    expect(resolve('app/core.py', 1, ['sub', 'deep'])).toEqual({ targets: ['app/sub/deep.py'] })
    expect(resolve('app/core.py', 3, ['x'])).toEqual({ targets: [] })
    expect(resolve('x.py', 0, ['requests', 'adapters'])).toEqual({
      targets: [],
      external: 'requests',
    })
  })

  it('finds source roots from pyproject.toml and src/ layouts', () => {
    const warnings: string[] = []
    const files = ['pyproject.toml', 'src/shop/__init__.py', 'scripts/tool.py']
    expect(sourceRoots(PYTHON_LAYERED, files, warnings)).toEqual(['src', ''])
    expect(warnings).toEqual([])
  })
})
