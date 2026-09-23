# ak-review

Architecture-first code review for TypeScript and Python. A live, drillable diagram of a
repo (components → modules → classes/functions → source) with dependency-rule violations,
cycles and complexity, built for reviewing changes from the top down with Claude alongside.

See [docs/DESIGN.md](docs/DESIGN.md) for the goals, decisions and phase plan.
MIT licensed.

## Run

Needs Node 24+, pnpm and git.

```bash
pnpm install
pnpm build                  # UI into dist/web, CLI bundle into dist/cli.js
node src/cli/main.ts serve ../some-repo
node src/cli/main.ts extract ../some-repo   # IR + layer violations to stdout
```

Or, after `pnpm build`, `pnpm link --global` once and use `ak-review serve [repo]` anywhere.
`ak-review --help` lists commands and flags (`--port`, `--host`, `--no-open`).

The first run creates `<repo>/.ak-review/` with a commented `policy.yaml` and its own
`.gitignore`, which keeps only the policy. Everything else in there (`ir.json`) is generated.

## Use

- Double-click a box to open it; **Esc** goes up a level (or closes the source panel).
- Click a box or arrow to inspect it. Arrows bundle every `from → to` pair they carry;
  hover for the list, click for all of them with call-site lines.
- Components show module imports. Inside a module or class the arrows are calls, and
  outside callers and callees appear as dashed ghost boxes.
- Red arrows are layer violations, orange ones are cycles, and dashed ones are type-only.
- The view follows file saves: source edits re-extract, policy edits just regroup.

## Policy

`.ak-review/policy.yaml`. Globs match repo-relative module paths.

```yaml
exclude: ['**/*.test.*', '**/test/**']
groups:                  # regroup modules instead of using directories
  - name: presentation
    match: ['src/ui/**', 'src/canvas/**']
layers:                  # outermost first; dependencies must point down the list
  - name: ui
    match: ['src/ui/**']
  - name: domain
    match: ['src/model/**']
omit: ['src/legacy/**', 'src/app.ts#debugDump']
```

## Develop

```bash
pnpm dev ../architorio   # binds 0.0.0.0 (LAN + Tailscale); server restarts on change, UI hot-reloads
pnpm test
pnpm build               # lint (boundaries) + fmt:check + tsc -b + vite build
pnpm smoke                    # pack, npm-install into a scratch dir, run the installed CLI
node tools/capture-cdp.mjs --url http://127.0.0.1:4410/ --out shots/01.png
```
