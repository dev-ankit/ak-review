import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'

/**
 * `<repo>/.ak-review/policy.yaml` decides what the diagram shows and how it is grouped.
 * Globs match repo-relative module paths. The IR is never edited; the policy is.
 */
export interface Policy {
  /** Modules shown (default: everything). */
  include: string[]
  exclude: string[]
  /** Regroup modules into named components instead of their directories. First match wins. */
  groups: NamedGlobs[]
  /** Outermost first. An inner layer depending on an outer one is a violation. */
  layers: NamedGlobs[]
  /** Node ids (modules, symbols) or module globs to hide. */
  omit: string[]
}

export interface NamedGlobs {
  name: string
  match: string[]
}

export const DEFAULT_EXCLUDE = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
]

export const DEFAULT_POLICY: Policy = {
  include: ['**'],
  exclude: DEFAULT_EXCLUDE,
  groups: [],
  layers: [],
  omit: [],
}

const TEMPLATE = `# ak-review policy. Edit freely, or ask your agent to; the viewer reloads on save.
# Globs match repo-relative module paths, e.g. src/ui/App.tsx.

# include: ['**']
exclude:
${DEFAULT_EXCLUDE.map((g) => `  - '${g}'`).join('\n')}

# Regroup modules into named components (default: the directory tree).
# The part of the path below a glob's static base is kept, so src/ui/panels/X.tsx
# lands in presentation/panels/.
# groups:
#   - name: presentation
#     match: ['src/ui/**', 'src/canvas/**']

# Layers, outermost (details) first. Dependencies must point inward, down this list;
# an inner layer that depends on an outer one is drawn red.
# layers:
#   - name: ui
#     match: ['src/ui/**']
#   - name: domain
#     match: ['src/model/**']

# Hide modules or symbols by id or glob.
# omit: []
`

export function policyPath(root: string): string {
  return join(root, '.ak-review', 'policy.yaml')
}

/**
 * Create `.ak-review/` with a commented policy and a .gitignore that keeps only the policy,
 * so the tool never touches the repo's own ignore rules.
 */
export function ensureWorkspace(root: string): void {
  const dir = join(root, '.ak-review')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const gitignore = join(dir, '.gitignore')
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n!.gitignore\n!policy.yaml\n')
  if (!existsSync(policyPath(root))) writeFileSync(policyPath(root), TEMPLATE)
}

export function loadPolicy(root: string): { policy: Policy; error?: string } {
  const file = policyPath(root)
  if (!existsSync(file)) return { policy: DEFAULT_POLICY }
  try {
    return { policy: parsePolicy(parse(readFileSync(file, 'utf8')) ?? {}) }
  } catch (e) {
    return { policy: DEFAULT_POLICY, error: `policy.yaml: ${(e as Error).message}` }
  }
}

export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected a mapping at the top level')
  }
  const doc = raw as Record<string, unknown>
  return {
    include: globs(doc.include, 'include') ?? DEFAULT_POLICY.include,
    exclude: globs(doc.exclude, 'exclude') ?? DEFAULT_POLICY.exclude,
    groups: named(doc.groups, 'groups'),
    layers: named(doc.layers, 'layers'),
    omit: globs(doc.omit, 'omit') ?? [],
  }
}

function globs(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value
  throw new Error(`${field} must be a list of globs`)
}

function named(value: unknown, field: string): NamedGlobs[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`)
  return value.map((entry, i) => {
    const e = entry as Record<string, unknown>
    if (typeof e?.name !== 'string' || e.name === '') {
      throw new Error(`${field}[${i}] needs a name`)
    }
    const match = globs(e.match, `${field}[${i}].match`)
    if (!match) throw new Error(`${field}[${i}] needs match globs`)
    return { name: e.name, match }
  })
}
