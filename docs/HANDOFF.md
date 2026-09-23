# Handoff

Status as of 2026-09-23. Read `docs/DESIGN.md` (goals, decisions, phases) and `CLAUDE.md`
(stack, commands, conventions) first; this file is what they don't cover: where things
stand, what to do next, and what bit us.

## Where things stand

- **Phase 1 is done**: IR, TypeScript extractor, policy, web viewer (drill-down, layer
  violations, cycles, complexity, source panel), Effect v4 CLI (`serve`, `extract`),
  Rolldown bundle for npm, CI on Linux/macOS/Windows (all green).
- Repo: https://github.com/dev-ankit/ak-review (public, MIT). One commit on `main`.
- **Not published to npm.** The user decides when (suggested: after phase 2). Don't run
  `npm publish` without asking.
- Verified on real repos: `C:\Repos\ankit\architorio` (81 modules, ~1.8s) and ak-review
  itself (its own `.ak-review/policy.yaml` checks its layers: 0 violations).

## Next: phase 2, the Python extractor

Goal: `ak-review serve C:\Repos\external\pptx-gen` shows the same views it shows for TS.
pptx-gen is ~550 `.py` files, uv-managed, `requires-python >=3.12,<3.13`.

The contract is `Extractor` in `src/lang/extractor.ts` producing the IR in
`src/core/ir.ts`. Nothing downstream of the IR should need to change. Model the work on
`src/lang/ts/extract.ts`.

1. **`src/lang/py/extract.ts`**: `name: 'python'`, `extensions: ['.py']`,
   `configFiles: /(^|\/)(pyproject\.toml|setup\.cfg|pyrightconfig\.json)$/`. Register it in
   `src/lang/index.ts`. Use `listRepoFiles` (git-aware) for discovery, like the TS extractor.
2. **Structure** (modules, symbols, ranges, complexity): tree-sitter via `web-tree-sitter`
   plus a Python grammar `.wasm`. Check which npm package actually ships a prebuilt
   `tree-sitter-python.wasm` for the current web-tree-sitter ABI before committing to one.
   Symbols: top-level `def`/`async def` → `function`, `class` → `class` with methods
   (`method`), module-level assignments → `variable`. Nested defs belong to their enclosing
   symbol, same as TS. `exported` = name not starting with `_` (or listed in `__all__`).
   Complexity: 1 + if/elif, for, while, except, conditional expression, `and`/`or`,
   comprehension `if`, `case`.
3. **Imports**: resolving them yourself is simpler and deterministic. Source roots = repo
   root, plus `src/` if present, plus package dirs from `pyproject.toml`. Handle relative
   imports (`from . import x`, `from ..a import b`), `import a.b.c`, and packages
   (`a/b/__init__.py`). Unresolved → `externals` (top-level package name). Imports under
   `if TYPE_CHECKING:` are `typeOnly: true`.
4. **Calls**: Pyright (npm `pyright`, runs on Node, no Python needed) as a language server
   (`pyright-langserver --stdio`). For each call site tree-sitter finds, send
   `textDocument/definition` and map the returned location onto a symbol range → call edge
   with the call-site line. Batch requests concurrently; 550 files is thousands of requests.
   Record the owner the same way TS does (the enclosing top-level symbol or method; module
   id for top-level code). A missing `.venv` is fine: local definitions still resolve.
5. **Tests**: add `test/fixtures/python-layered/` mirroring `test/fixtures/layered/`
   (layer violation, cycle, class with methods, re-export via `__init__.py`, relative
   imports, a `TYPE_CHECKING` import), and `test/py-extract.test.ts` mirroring
   `test/ts-extract.test.ts`. Default policy already excludes Python test files.
6. **Packaging**: new runtime deps go in `dependencies` (Rolldown externalizes everything
   in there automatically). Grammar `.wasm` files must be loadable from the installed
   package: extend `pnpm smoke` to extract a Python fixture too. CI must stay green on all
   three OSes.
7. Then screenshot pptx-gen (below) and look at it before calling it done.

## How to work here

```bash
pnpm install
pnpm dev ../architorio        # viewer on :4410, bound to 0.0.0.0 (Tailscale works)
pnpm test
pnpm build                    # lint + fmt:check + tsc -b + vite build + rolldown
pnpm smoke                    # pack → npm install → run the installed CLI
node tools/capture-cdp.mjs --url "http://127.0.0.1:4410/#focus=src%2F" --out shots/x.png \
  --width 1500 --height 900 --settle 2500 [--click '<css>']
```

Git identity is set globally (Ankit Khullar <khullar.ankit@gmail.com>). Commit attribution
follows the session's system instructions.

## Gotchas we already hit

- **Stale PATH in agent shells.** `python` may resolve to the Microsoft Store stub, and
  `pnpm` may be missing. Prepend `/c/Users/ankit/AppData/Roaming/npm` (pnpm) or refresh
  PATH from the registry. Python 3.13 is the system one; pptx-gen needs 3.12, which is
  uv-managed (`uv python find 3.12`). uv is installed via winget.
- **pnpm 12** has no `-s` flag. Arguments pass straight through: `pnpm dev <repo>`, no `--`.
- **Formatting fails the build.** Run `pnpm fmt` after edits, especially after rewriting
  `package.json` programmatically. Don't chain `pnpm build; git commit`: use `&&`.
- **Node runs `.ts` directly in dev** (type stripping): imports need `.ts` extensions, and
  only erasable syntax is allowed. Node refuses type stripping under `node_modules`, which
  is why the published package ships `dist/cli.js`.
- **TS 7 has no compiler API.** Analysis uses `@typescript/typescript6` (it re-exports
  `@typescript/old`; look there for `.d.ts` details). `ImportClause.isTypeOnly` is
  deprecated; use `phaseModifier`.
- **Gitignored files must stay out.** A minified bundle in architorio's ignored `reviews/`
  once showed complexity 4178. Always discover files via `listRepoFiles`.
- **Boundaries.** `pnpm lint` enforces `core` (pure) / `lang` / `server` / `cli` / `web`.
  Effect is used only in `src/cli`.
- **The T3 preview panel can't reach the local server.** Use `tools/capture-cdp.mjs`
  (headless Edge) for screenshots.
- **Running `serve`/`extract` on a repo writes `<repo>/.ak-review/`** (policy + its own
  `.gitignore`). That's intended; mention it to the user when you do it to one of their
  repos.

## Known gaps (planned, not bugs)

- Module-level call views are a hairball on big files (architorio's `edit.ts`: 41 boxes,
  123 arrows). Phase 6's lineage view (one function ± N hops) fixes it; don't patch it in
  phase 2.
- Calls through interface-typed receivers are unresolved (phase 6: AI fill-in).
- `serve`'s graceful Ctrl+C shutdown (Effect scope finalizers) is untested on Windows.
- The UI bundle is 1.8 MB (elkjs); fine for a local tool for now.
