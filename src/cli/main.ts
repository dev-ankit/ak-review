import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, Option } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'

import pkg from '../../package.json' with { type: 'json' }
import { startServer } from '../server/http.ts'
import { Session } from '../server/session.ts'

const repo = Argument.Directory('repo', { mustExist: true }).pipe(
  Argument.withDescription('Repository to analyze'),
  Argument.withDefault('.'),
)

/** A session that has extracted once and watches the repo until the scope closes. */
const watchedSession = (root: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const session = new Session(root)
      await session.extract()
      session.watch()
      return session
    }),
    (session) => Effect.sync(() => session.close()),
  )

const serve = Command.make(
  'serve',
  {
    repo,
    port: Flag.Int('port').pipe(
      Flag.withAlias('p'),
      Flag.withDescription('Port to listen on (default 4410; the next free one is used if taken)'),
      Flag.withDefault(4410),
    ),
    host: Flag.String('host').pipe(
      Flag.withDescription(
        'Interface to bind (default 127.0.0.1). 0.0.0.0 exposes the viewer, and the repo source, to your LAN and Tailscale',
      ),
      Flag.withDefault('127.0.0.1'),
    ),
    open: Flag.Boolean('open').pipe(
      Flag.withDescription('Open a browser (default: on, except with --dev)'),
      Flag.optional,
    ),
    dev: Flag.Boolean('dev').pipe(
      Flag.withDescription('Serve the UI through Vite with hot reload (ak-review development)'),
      Flag.withDefault(false),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const root = resolve(config.repo)
      const session = yield* watchedSession(root)
      const server = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          startServer({ session, port: config.port, host: config.host, dev: config.dev }),
        ),
        (server) => Effect.promise(() => server.close()),
      )
      const local = `http://127.0.0.1:${server.port}/`
      yield* Console.log(`ak-review: ${root}\n  local:     ${local}`)
      for (const { address, tailscale } of networkAddresses(config.host)) {
        yield* Console.log(
          `  ${tailscale ? 'tailscale' : 'network  '}: http://${address}:${server.port}/`,
        )
      }
      if (Option.getOrElse(config.open, () => !config.dev)) openBrowser(local)
      // Serve until interrupted (Ctrl+C); the scope then closes the server and the watcher.
      return yield* Effect.never
    }).pipe(Effect.scoped),
).pipe(Command.withDescription('Analyze a repo and serve the architecture viewer'))

const extract = Command.make('extract', { repo }, (config) =>
  Effect.gen(function* () {
    const root = resolve(config.repo)
    const session = new Session(root)
    yield* Effect.promise(() => session.extract())
    const model = session.model!
    const violations = model.edges.filter((e) => e.violation && e.kind === 'import')
    if (model.layers.length > 0) {
      yield* Console.log(
        `layers: ${model.layers.join(' > ')}; ${violations.length} violating imports`,
      )
      for (const v of violations) yield* Console.log(`  ${v.from} -> ${v.to}`)
    }
    for (const w of model.warnings) yield* Console.warn(`warning: ${w}`)
    yield* Console.log(`wrote ${resolve(root, '.ak-review', 'ir.json')}`)
  }),
).pipe(Command.withDescription('Write <repo>/.ak-review/ir.json and print layer violations'))

const cli = Command.make('ak-review').pipe(
  Command.withDescription('Architecture-first code review for TypeScript and Python'),
  Command.withSubcommands([serve, extract]),
)

Command.run(cli, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)

/** Non-loopback IPv4 addresses the server is reachable on, Tailscale (100.64/10) first. */
function networkAddresses(host: string): { address: string; tailscale: boolean }[] {
  if (host !== '0.0.0.0' && host !== '::') {
    return host === '127.0.0.1' || host === 'localhost' ? [] : [{ address: host, tailscale: false }]
  }
  const isTailscale = (ip: string) => {
    const [a, b] = ip.split('.').map(Number)
    return a === 100 && b! >= 64 && b! <= 127
  }
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal)
    .map((i) => ({ address: i!.address, tailscale: isTailscale(i!.address) }))
    .sort((x, y) => Number(y.tailscale) - Number(x.tailscale))
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
}
