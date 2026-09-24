import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * A minimal LSP client for `pyright-langserver --stdio`, enough for its call hierarchy.
 * Pyright runs on Node; no Python install is needed (without an interpreter it just can't
 * see third-party packages, which the IR doesn't track anyway).
 *
 * What makes it fast enough, measured on a 550-file repo:
 * - Files are opened first. Pyright re-tokenizes a closed file for every call it
 *   resolves, which is quadratic in file size; open files keep their tokens.
 * - Pyright type-checks open files in the background, which costs more than all the
 *   queries together, but postpones that while the client is active (definition requests
 *   count as activity). `query` sends a cheap one ahead of each request. If checking runs
 *   anyway, answers only come slower.
 */

export interface Position {
  line: number
  character: number
}

/** A function or class, as the call hierarchy reports it; `selectionRange` is its name. */
export interface CallItem {
  uri: string
  selectionRange: { start: Position }
}

export interface OutgoingCall {
  to: CallItem
  /** The call sites in the caller. */
  fromRanges: { start: Position }[]
}

export interface PyrightSettings {
  /** Absolute directories searched for imports besides the workspace root. */
  extraPaths: string[]
  /** The project's interpreter, e.g. its `.venv`, for third-party packages. */
  pythonPath?: string
}

interface Message {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

const REQUEST_TIMEOUT_MS = 120_000
/** Logged once Pyright has applied the settings (search paths) and listed the workspace. */
const WORKSPACE_LISTED = /^(Found \d+ source files?|No source files found)/
const LISTING_TIMEOUT_MS = 60_000

export class Pyright {
  private readonly process: ChildProcess
  private readonly settings: PyrightSettings
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  private nextId = 0
  private buffer = Buffer.alloc(0)
  private failure: Error | undefined
  private listed: () => void = () => {}

  private constructor(root: string, settings: PyrightSettings) {
    this.settings = settings
    const require = createRequire(import.meta.url)
    const server = require.resolve('pyright/langserver.index.js')
    // stderr is noise: e.g. the Windows Store `python` stub Pyright probes for an interpreter.
    this.process = spawn(process.execPath, [server, '--stdio'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    this.process.stdout!.on('data', (chunk: Buffer) => this.receive(chunk))
    this.process.on('error', (e) => this.fail(e))
    this.process.on('exit', (code) => this.fail(new Error(`pyright exited with code ${code}`)))
    this.process.stdin!.on('error', (e) => this.fail(e))
  }

  static async start(root: string, settings: PyrightSettings): Promise<Pyright> {
    const server = new Pyright(root, settings)
    const rootUri = pathToFileURL(root).href
    await server.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true } },
    })
    let timer: NodeJS.Timeout | undefined
    const listed = new Promise<void>((resolve) => {
      server.listed = resolve
      timer = setTimeout(resolve, LISTING_TIMEOUT_MS)
    })
    server.notify('initialized', {})
    await listed
    clearTimeout(timer)
    return server
  }

  /** Opens files with their current text. */
  open(files: { path: string; text: string }[]): void {
    if (files.length > 0) this.stayActive(files[0]!.path)
    for (const { path, text } of files) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri: pathToFileURL(path).href, languageId: 'python', version: 1, text },
      })
    }
  }

  /**
   * Calls made by the function whose name is at `at`, nested functions included; null
   * when there are none. Pyright only reads the item's uri and start, so no
   * prepareCallHierarchy round trip is needed.
   */
  async outgoingCalls(file: string, at: Position): Promise<OutgoingCall[] | null> {
    const range = { start: at, end: at }
    const item = { name: '', kind: 12, uri: pathToFileURL(file).href, range, selectionRange: range }
    return (await this.query(file, 'callHierarchy/outgoingCalls', { item })) as
      | OutgoingCall[]
      | null
  }

  /** The function or class called by the name at `at`. */
  async callee(file: string, at: Position): Promise<CallItem | undefined> {
    const items = (await this.query(file, 'textDocument/prepareCallHierarchy', {
      textDocument: { uri: pathToFileURL(file).href },
      position: at,
    })) as CallItem[] | null
    return items?.[0]
  }

  /** Asks Pyright to exit, and kills it if it hasn't within a second. */
  async shutdown(): Promise<void> {
    if (this.process.exitCode !== null) return
    let timer: NodeJS.Timeout | undefined
    const exited = new Promise<void>((resolve) => {
      this.process.once('exit', () => resolve())
      timer = setTimeout(resolve, 1000)
    })
    if (!this.failure) {
      try {
        await this.request('shutdown', null)
        this.notify('exit', null)
      } catch {
        // Killed below either way.
      }
    }
    await exited
    clearTimeout(timer)
    this.process.kill()
  }

  private query(file: string, method: string, params: unknown): Promise<unknown> {
    this.stayActive(file)
    return this.request(method, params)
  }

  /** A definition request Pyright answers at once, and counts as activity (see above). */
  private stayActive(file: string): void {
    this.request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(file).href },
      position: { line: 0, character: 0 },
    }).catch(() => {})
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`pyright: ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    if (!this.failure) this.send({ method, params })
  }

  private send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    this.process.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString('utf8'))
      this.buffer = this.buffer.subarray(start + length)
      this.dispatch(message as Message)
    }
  }

  private dispatch(message: Message): void {
    if (message.method === undefined) {
      const waiter = this.pending.get(message.id as number)
      this.pending.delete(message.id as number)
      if (message.error) waiter?.reject(new Error(`pyright: ${message.error.message}`))
      else waiter?.resolve(message.result)
    } else if (message.method === 'window/logMessage') {
      const text = (message.params as { message?: string }).message ?? ''
      if (WORKSPACE_LISTED.test(text)) this.listed()
    } else if (message.id !== undefined) {
      // A request from the server. Only configuration needs a real answer.
      const result =
        message.method === 'workspace/configuration'
          ? (message.params as { items: { section?: string }[] }).items.map((item) =>
              this.configuration(item.section),
            )
          : null
      this.send({ id: message.id, result })
    }
  }

  private configuration(section: string | undefined): unknown {
    const analysis = {
      autoSearchPaths: true,
      extraPaths: this.settings.extraPaths,
      diagnosticMode: 'openFilesOnly',
      typeCheckingMode: 'off',
    }
    if (section === 'python') return { pythonPath: this.settings.pythonPath, analysis }
    if (section === 'python.analysis') return analysis
    return null
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const waiter of this.pending.values()) waiter.reject(this.failure)
    this.pending.clear()
  }
}
