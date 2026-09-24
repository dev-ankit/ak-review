# ak-review

Architecture-first code review tool for TypeScript and Python. Read `docs/DESIGN.md` and
`docs/HANDOFF.md` (current status, next steps, gotchas) first. DESIGN.md has the
decisions from the design interview and the phase plan. Stay inside the plan;
don't add features the user ruled out (e.g. an agent that refactors code to match a
proposal).

## Stack

Node 24 (runs `.ts` directly via type stripping, so no build step for the server), Vite 8,
React 19, TypeScript 7 (native `tsc`) for type checking, `@typescript/typescript6` for the
compiler API the TS extractor needs, `web-tree-sitter` and Pyright (as a language server)
for the Python extractor, `@xyflow/react` + `elkjs` for the diagram, Zustand,
Vitest, Oxfmt. The CLI (`src/cli`) is Effect v4 (`effect/unstable/cli` +
`@effect/platform-node`, pinned to an exact rc); Effect is not used elsewhere yet.
Rolldown bundles the CLI into `dist/cli.js` for publishing.

## Commands

```bash
pnpm dev <repo>        # serve <repo> on 0.0.0.0 (Tailscale) with Vite HMR; restarts on change
pnpm test
pnpm build             # lint + fmt:check + tsc -b + vite build
pnpm fmt
pnpm smoke             # pack + npm install + run the installed CLI (before any release)
node src/cli/main.ts extract <repo>
```

## Conventions

- Layers (enforced by `pnpm lint`, and by ak-review's own `.ak-review/policy.yaml`):
  `core` is pure and shared by server and browser (no node, no packages); `lang` holds
  extractors; `server` never imports `web`; `web` imports only `core`.
- The IR (`src/core/ir.ts`) is the extractor contract. A new language is a new `Extractor`
  in `src/lang/<lang>/` registered in `src/lang/index.ts`; nothing downstream changes.
- Node runs the TS sources directly in development, but refuses to type-strip files under
  node_modules, so the published package ships the Rolldown bundle. Runtime deps stay external
  and must be in `dependencies`; UI libraries are devDependencies (the UI ships prebuilt).
- Node runs the TS sources directly: imports use `.ts` extensions, and only erasable
  syntax is allowed (no enums, namespaces or parameter properties; `erasableSyntaxOnly`).
- Formatting is Oxfmt (no semicolons, single quotes, width 100). The build fails on
  unformatted files.
- Test against real repos, not just the fixture: `C:\Repos\ankit\architorio` (TS),
  this repo, and `C:\Repos\external\pptx-gen` (Python).
- After a visible UI change, capture screenshots with `tools/capture-cdp.mjs` (headless
  Edge/Chrome, `--click` for states) and look at them before calling it done.
