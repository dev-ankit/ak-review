import { describe, expect, it } from 'vitest'

import { buildModel } from '../src/server/build-model.ts'
import { DEFAULT_POLICY, type Policy, parsePolicy } from '../src/server/policy.ts'
import { layeredIr } from './fixture.ts'

const ir = layeredIr()
const policy = (p: Partial<Policy>): Policy => ({ ...DEFAULT_POLICY, ...p })

describe('buildModel', () => {
  it('builds the directory tree and keeps the repo root when there are several top dirs', () => {
    const model = buildModel(ir, DEFAULT_POLICY)
    expect(model.rootId).toBe('/')
    expect(model.nodes['/']!.children).toEqual(['scripts/', 'src/'])
    expect(model.nodes['src/']!.children).toEqual(['src/lib/', 'src/model/', 'src/ui/'])
    expect(model.nodes['src/ui/']!.children).toEqual(['src/ui/App.tsx', 'src/ui/format.ts'])
    expect(model.nodes['src/model/store.ts#Store']!.children).toEqual([
      'src/model/store.ts#Store.add',
      'src/model/store.ts#Store.find',
      'src/model/store.ts#Store.label',
    ])
  })

  it('collapses a single top-level directory into the root', () => {
    const model = buildModel(ir, policy({ exclude: ['scripts/**'] }))
    expect(model.rootId).toBe('src/')
    expect(model.nodes['src/']!.parent).toBeNull()
    expect(model.nodes['/']).toBeUndefined()
  })

  it('aggregates loc and max complexity into modules and components', () => {
    const model = buildModel(ir, DEFAULT_POLICY)
    expect(model.nodes['src/ui/format.ts']!.complexity).toBe(3)
    expect(model.nodes['src/ui/']!.complexity).toBe(3)
    const [app, format] = ['src/ui/App.tsx', 'src/ui/format.ts'].map((id) => model.nodes[id]!.loc!)
    expect(model.nodes['src/ui/']!.loc).toBe(app! + format!)
  })

  it('flags imports and calls from an inner layer to an outer one', () => {
    const model = buildModel(
      ir,
      policy({
        layers: [
          { name: 'ui', match: ['src/ui/**'] },
          { name: 'model', match: ['src/model/**'] },
        ],
      }),
    )
    const violations = model.edges.filter((e) => e.violation).map((e) => `${e.from} -> ${e.to}`)
    expect(violations.sort()).toEqual([
      'src/model/store.ts -> src/ui/format.ts',
      'src/model/store.ts#Store.label -> src/ui/format.ts#formatName',
    ])
    expect(model.nodes['src/ui/']!.layer).toBe('ui')
    expect(model.nodes['src/']!.layer).toBeUndefined()
  })

  it('regroups modules under named components, keeping the path below the glob base', () => {
    const model = buildModel(
      ir,
      policy({ groups: [{ name: 'presentation', match: ['src/ui/**', 'src/lib/**'] }] }),
    )
    expect(model.nodes['src/ui/App.tsx']!.parent).toBe('presentation/')
    expect(model.nodes['src/lib/reexport.ts']!.parent).toBe('presentation/')
    expect(model.nodes['src/model/store.ts']!.parent).toBe('src/model/')
  })

  it('omits modules by glob and symbols by id, dropping their edges', () => {
    const model = buildModel(ir, policy({ omit: ['src/lib/**', 'src/model/store.ts#Store.label'] }))
    expect(model.nodes['src/lib/reexport.ts']).toBeUndefined()
    expect(model.nodes['src/model/store.ts#Store.label']).toBeUndefined()
    const touchesLib = (id: string) => id.startsWith('src/lib/')
    expect(model.edges.some((e) => touchesLib(e.from) || touchesLib(e.to))).toBe(false)
    expect(model.edges.some((e) => e.to === 'src/model/store.ts#Store.label')).toBe(false)
  })
})

describe('parsePolicy', () => {
  it('fills defaults and validates shape', () => {
    expect(parsePolicy({})).toEqual(DEFAULT_POLICY)
    expect(parsePolicy({ exclude: 'dist/**' }).exclude).toEqual(['dist/**'])
    expect(() => parsePolicy({ layers: [{ match: ['x'] }] })).toThrow('layers[0] needs a name')
    expect(() => parsePolicy([])).toThrow('mapping')
  })
})
