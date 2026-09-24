# ak-review design

Architecture-first code review for TypeScript and Python. Inspired by
[uml-viewer](https://github.com/unclebob/uml-viewer) (Clojure): a live, drillable UML
view of a codebase, coupled to an AI agent.

## Goals

Review a change from the top down:

1. **Architecture view** (MVP). Components → modules → classes/functions → source, with
   dependency-rule violations, cycles, metrics, and a diff overlay.
2. **Call lineage.** For any function, every upstream caller chain to the entry points and
   every downstream callee chain.
3. **AI-ordered review.** Split a PR into its core change and the mechanical fallout (a
   renamed function plus 100 files of call-site renames), then walk the core with Claude
   first.

## Decisions (interview, 2026-09-22)

| Topic | Decision |
|---|---|
| Languages | One app, one IR, one extractor per language. Mixed monorepos analyzed per language; no cross-language edges. |
| Form | Local web app: CLI starts a server bound to 127.0.0.1 and opens a browser. |
| Inputs | Whole repo, local branch diff, commit range, GitHub PR. |
| Scale | Small–medium repos (< 200k LOC); full analysis on demand. |
| AI | Claude Code as a companion over MCP, not embedded API calls. |
| Call graph | Type-aware (TS compiler, Pyright) with AI fill-in for unresolved edges, marked inferred. |
| Output | Stays local, plus an exportable markdown report. No GitHub posting. |
| Components | Directory tree by default; `policy.yaml` regroups and declares layers. |
| Elements | Drill-down: component → module → class/function → source. |
| Metrics | CRAP (complexity × coverage) and git churn. ak-review runs the tests, decoupled through files. |
| Carried over | Dependency-rule violations, what-if proposals (view-only), diff overlay. |
| Not doing | Agent refactoring the code to match a proposal. Point an agent at the output instead. |

## Pipeline

```
extractors ──► IR (.ak-review/ir.json) ──► policy (.ak-review/policy.yaml) ──► model ──► view
 lang/ts         raw topology               grouping, layers, filters          server     browser
 lang/py (2)
```

- **IR** (`src/core/ir.ts`): modules, symbols (with complexity and line ranges), import
  edges (type-only flagged), call edges (with call-site lines). Language-neutral. Never
  edited by hand or by agents.
- **Policy** (`src/server/policy.ts`): include/exclude, `groups` (regroup modules into named
  components), `layers` (outermost first), `omit`. Agents edit this.
- **Model** (`src/core/model.ts`, built in `src/server/build-model.ts`): one tree of
  components, modules and symbols, edges between visible nodes, layer violations,
  aggregated loc and max complexity.
- **View** (`src/core/view.ts`, computed in the browser): the children of a focus node,
  leaf edges lifted to that level and bundled. Components show imports; modules and classes
  show calls. Outside endpoints appear as ghost boxes (the sibling branch for imports, the
  exact function for calls). Cycles are strongly connected components at the current level,
  ignoring type-only edges.

### Extractors

- **TypeScript/JavaScript** (`src/lang/ts`): the TypeScript 6 compiler API
  (`@typescript/typescript6`; TS 7 no longer exports one). Every `tsconfig.json` /
  `jsconfig.json` seeds a program, following project references; tracked source files no
  config covers go into one loose program. The owning program's type checker resolves calls,
  including through aliases, namespaces, re-exports, `new`, and JSX. Calls through an
  interface-typed receiver stay unresolved for now; the AI fill-in in phase 6 covers them.
- **Python** (`src/lang/py`): tree-sitter (`web-tree-sitter` plus the grammar's `.wasm`,
  shipped in `dist/`) for symbols, ranges, complexity, imports and call sites. Imports are
  resolved by the extractor itself against the source roots (repo root, `src/`, package
  dirs from `pyproject.toml`): deterministic and interpreter-free. Calls come from Pyright
  (npm, no Python install needed) as a language server: `callHierarchy/outgoingCalls` for
  each function and method, `prepareCallHierarchy` for calls in module and class bodies.
  Every file is opened first (Pyright re-tokenizes closed files per call), and its
  background checking is kept postponed. `typeOnly` imports are the ones under
  `if TYPE_CHECKING:`.

File discovery uses `git ls-files --cached --others --exclude-standard`, so anything
gitignored (build output, bundles, scratch) stays out.

### Metrics (phase 3)

The runner and the overlay are decoupled through files. `policy.yaml` names the test
commands per language and the coverage file each writes (lcov for TS, `coverage.json` from
coverage.py). `ak-review metrics` runs them; the overlay only reads the files, so CI output
or a manual run works the same way. CRAP = CC² × (1 − cov)³ + CC. Churn comes from
`git log --numstat`.

### Diff overlay (phase 4)

Base and head are checked out into git worktrees, each extracted to its own IR. The diff is
between IRs: added/removed modules and dependency edges, and changed functions (diff hunks
mapped onto symbol ranges). A PR is fetched with `gh`.

### Claude companion (phase 5)

ak-review exposes an MCP server: `get_view_context` (what the user is looking at and has
selected), `get_model`, `get_lineage`, `write_proposal`, `show`, `highlight`. Proposals are
alternative policies rendered as diagrams marked "not in the code".

### Lineage (phase 6)

Upstream and downstream call trees for one function, from IR call edges plus Pyright/TS call
hierarchy, with Claude resolving unresolved edges (callbacks, DI, interface dispatch) on
demand, drawn as inferred. This also fixes the dense module-level call view: a function
plus N hops instead of the whole module.

### AI-ordered review (phase 7)

Classify the change deterministically first. For example, a symbol renamed in the IR diff
plus files whose only change is that identifier at call sites counts as mechanical. Claude
then handles the ambiguous parts and walks the core change first. Output: a markdown report
(core change, blast radius, risks).

## Distribution

- **npm package** (`npx ak-review serve`). `dist/cli.js` is a Rolldown bundle of the CLI,
  server and extractors (Node will not type-strip `.ts` under node_modules); `dist/web` is
  the prebuilt UI. Runtime deps (Effect, TS 6 API, Pyright, web-tree-sitter, picomatch, yaml,
  smol-toml) are installed, not bundled; the Python grammar `.wasm` is copied into `dist/`. `pnpm smoke` packs, installs with npm into a scratch dir and runs the result.
  The package stays `private` until public/private and a license are decided.
- **Claude Code plugin** (phase 5): the GitHub repo doubles as a plugin marketplace; the
  plugin's `.mcp.json` runs `npx -y ak-review@<version> mcp` and ships a review skill.
- **Later, if asked:** a PyPI shim so `uvx ak-review` works (as pyright does).
- `policy.yaml` is committed in user repos, so it is a public format: versioned, backward
  compatible. CI must cover Windows, macOS and Linux (path handling).

## Phases

1. IR, TS extractor, policy, web view with drill-down, violations, cycles. **(done)**
2. Python extractor. **(done)**
3. Metrics: complexity, coverage runner and import, churn; CRAP and hotspot coloring.
4. Diff overlay: branch, commit range, PR.
5. Claude companion over MCP; what-if proposals.
6. Lineage explorer.
7. AI-ordered review and markdown report.

Test repos: `C:\Repos\ankit\architorio` (TS), ak-review itself (TS),
`C:\Repos\external\pptx-gen` (Python, uv).
