# Handoff

Status as of 2026-09-23 (phase 2). Read `docs/DESIGN.md` (goals, decisions, phases) and `CLAUDE.md`
(stack, commands, conventions) first; this file is what they don't cover: where things
stand, what to do next, and what bit us.

## Where things stand

- **Phase 1 is done**: IR, TypeScript extractor, policy, web viewer (drill-down, layer
  violations, cycles, complexity, source panel), Effect v4 CLI (`serve`, `extract`),
  Rolldown bundle for npm, CI on Linux/macOS/Windows.
- **Phase 2 is done**: the Python extractor (`src/lang/py/`, see DESIGN.md). Verified on
  `C:\Repos\external\pptx-gen` (547 `.py` files, 37k call edges, about 38s; screenshots
  looked right at root, `src/pptgen/`, `spec/` and `spec/loader.py`), on architorio (81
  modules, unchanged) and on ak-review itself (0 violations).
- `Extractor.extract` is now async (Pyright answers over LSP). `extractAll`,
  `Session.extract` and the fixtures await it; session refreshes run one at a time through
  a queue, and `POST /api/refresh` answers after the extraction.
- Repo: https://github.com/dev-ankit/ak-review (public, MIT).
- **Not published to npm.** The user decides when (suggested: after phase 2, so now is the
  time to ask). Don't run `npm publish` without asking.

## Next: phase 3, metrics

See DESIGN.md "Metrics (phase 3)": coverage runner and import (lcov for TS, coverage.py's
`coverage.json` for Python), git churn, CRAP, hotspot coloring. The runner and the overlay
talk only through files.

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

- **Pyright performance traps** (each cost minutes on pptx-gen before the fix):
  closed files are re-tokenized for every call Pyright resolves (quadratic), so every file
  is opened first; open files get type-checked in the background, which
  `Pyright.stayActive` postpones (a cheap definition request before each query counts as
  user activity); per-call-site definition requests are much slower than one
  `outgoingCalls` per function (and `definition` maps typeshed stubs to sources on every
  call). Profile with `node --cpu-prof` on `langserver.index.js` before guessing.
- **Pyright URIs** come back as `file:///c%3A/...`; compare paths via `fileURLToPath`,
  never raw strings.
- **tree-sitter nodes are fresh wrappers per access**: compare `node.id`, not references.
  Columns are UTF-16, the same as LSP.
- **pnpm supply-chain policy** rejects packages younger than its minimum release age, and
  `pnpm add` may silently add a `minimumReleaseAgeExclude` to `pnpm-workspace.yaml`.
  Don't keep it; pin an older version instead (`smol-toml` is on 1.8 for that reason).
- **tree-sitter-python is a dev dependency** on purpose: only its `.wasm` is used, and Rolldown
  copies that into `dist/`. As a runtime dependency its native install script made npm warn.

## Known gaps (planned, not bugs)

- Python extraction is whole-repo on every save (about 38s on pptx-gen, half of it tests).
  No incremental extraction yet.
- Python calls through untyped or dynamically dispatched receivers stay unresolved, and
  calls in module/class bodies are only asked for names some repo symbol has (phase 6 fills
  the rest).

- Module-level call views are a hairball on big files (architorio's `edit.ts`: 41 boxes,
  123 arrows). Phase 6's lineage view (one function ± N hops) fixes it; don't patch it in
  phase 2.
- Calls through interface-typed receivers are unresolved (phase 6: AI fill-in).
- `serve`'s graceful Ctrl+C shutdown (Effect scope finalizers) is untested on Windows.
- The UI bundle is 1.8 MB (elkjs); fine for a local tool for now.
