import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ViteDevServer } from 'vite'

import type { Session } from './session.ts'

/** The built UI: next to the bundled CLI (`dist/cli.js`), or in dist/ when run from source. */
const WEB_DIST = [new URL('./web/', import.meta.url), new URL('../../dist/web/', import.meta.url)]
  .map((url) => fileURLToPath(url))
  .find((dir) => existsSync(join(dir, 'index.html')))
const VITE_CONFIG = fileURLToPath(new URL('../../vite.config.ts', import.meta.url))

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export interface ServerOptions {
  session: Session
  port: number
  /**
   * Interface to bind. The API serves source code, so the default is loopback only;
   * `0.0.0.0` exposes it to every network the machine is on (LAN, Tailscale).
   */
  host: string
  /** Serve the UI through Vite with HMR instead of from dist/web. */
  dev: boolean
}

export interface RunningServer {
  /** The port actually bound: the next free one if the requested port is taken. */
  port: number
  close: () => Promise<void>
}

export async function startServer({
  session,
  port,
  host,
  dev,
}: ServerOptions): Promise<RunningServer> {
  const server = createServer()
  let vite: ViteDevServer | undefined
  if (dev) {
    const { createServer: createVite } = await import('vite')
    vite = await createVite({
      configFile: VITE_CONFIG,
      // IPs always pass Vite's DNS-rebinding host check; names need allowing. `.ts.net`
      // covers Tailscale MagicDNS names.
      server: { middlewareMode: true, hmr: { server }, allowedHosts: ['.ts.net'] },
      appType: 'spa',
    })
  }
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/')) return api(session, url, req, res)
    if (vite) return vite.middlewares(req, res)
    serveStatic(url.pathname, res)
  })
  const bound = await listen(server, host, port)
  const close = async () => {
    await vite?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
  return { port: bound, close }
}

function api(session: Session, url: URL, req: IncomingMessage, res: ServerResponse): void {
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/model':
        if (!session.model) return send(res, 503, { error: 'extracting' })
        return send(res, 200, session.model)
      case 'GET /api/source': {
        const file = url.searchParams.get('file') ?? ''
        // Only files the extractors produced; never an arbitrary path.
        if (!session.ir?.modules.some((m) => m.id === file)) {
          return send(res, 404, { error: 'unknown file' })
        }
        return send(res, 200, { file, text: readFileSync(join(session.root, file), 'utf8') })
      }
      case 'GET /api/events':
        return events(session, req, res)
      case 'POST /api/refresh':
        void session
          .reextract()
          .then(() => send(res, 200, { generatedAt: session.model?.generatedAt }))
        return
      default:
        return send(res, 404, { error: 'not found' })
    }
  } catch (e) {
    send(res, 500, { error: (e as Error).message })
  }
}

function events(session: Session, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 1000\n\n')
  const unsubscribe = session.subscribe((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  })
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function serveStatic(pathname: string, res: ServerResponse): void {
  if (!WEB_DIST) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('UI not built. Run `pnpm build`, or start with --dev.')
    return
  }
  let file = resolve(WEB_DIST, '.' + decodeURIComponent(pathname))
  if (
    !file.startsWith(resolve(WEB_DIST) + sep) ||
    !existsSync(file) ||
    statSync(file).isDirectory()
  ) {
    file = join(WEB_DIST, 'index.html')
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

async function listen(server: Server, host: string, port: number): Promise<number> {
  for (let p = port; p < port + 20; p++) {
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail)
        server.listen(p, host, () => {
          server.off('error', fail)
          ok()
        })
      })
      return p
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
    }
  }
  throw new Error(`no free port in ${port}-${port + 19}`)
}
