import { type FSWatcher, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Ir } from '../core/ir.ts'
import type { Model } from '../core/model.ts'
import { type Extractor, isIgnoredPath } from '../lang/extractor.ts'
import { extractAll, extractors as allExtractors } from '../lang/index.ts'
import { buildModel } from './build-model.ts'
import { ensureWorkspace, loadPolicy } from './policy.ts'

export type SessionEvent =
  | { type: 'model'; generatedAt: string }
  | { type: 'status'; message: string }

/**
 * One analyzed repo: its IR, the model built from it under the current policy, and the
 * watcher that keeps both fresh. Source changes re-extract; policy edits only rebuild.
 */
export class Session {
  readonly root: string
  ir: Ir | undefined
  model: Model | undefined
  private readonly extractors: Extractor[]
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private pending: 'extract' | 'policy' | undefined
  /** Refreshes run one at a time; an extraction can take seconds (Pyright). */
  private queue: Promise<void> = Promise.resolve()

  constructor(root: string, extractors: Extractor[] = allExtractors) {
    this.root = root
    this.extractors = extractors
    ensureWorkspace(root)
  }

  async extract(): Promise<void> {
    this.emit({ type: 'status', message: 'extracting' })
    const started = performance.now()
    this.ir = await extractAll(this.root, this.extractors)
    writeFileSync(join(this.root, '.ak-review', 'ir.json'), JSON.stringify(this.ir))
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.log(
      `extracted ${this.ir.modules.length} modules, ${this.ir.imports.length} imports, ` +
        `${this.ir.calls.length} calls in ${seconds}s`,
    )
    this.rebuild()
  }

  rebuild(): void {
    if (!this.ir) return
    const { policy, error } = loadPolicy(this.root)
    if (error) console.warn(error)
    this.model = buildModel(this.ir, policy, error ? [error] : [])
    this.emit({ type: 'model', generatedAt: this.model.generatedAt })
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  watch(): void {
    const relevant = (rel: string) =>
      this.extractors.some(
        (x) => x.extensions.some((ext) => rel.endsWith(ext)) || x.configFiles.test(rel),
      )
    this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const rel = filename.replaceAll('\\', '/')
      if (rel === '.ak-review/policy.yaml') this.schedule('policy')
      else if (!isIgnoredPath(rel) && relevant(rel)) this.schedule('extract')
    })
  }

  close(): void {
    this.watcher?.close()
    clearTimeout(this.timer)
  }

  private schedule(work: 'extract' | 'policy'): void {
    if (this.pending !== 'extract') this.pending = work
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.enqueue(), 300)
  }

  /** Re-extract now, after any refresh in flight. */
  reextract(): Promise<void> {
    this.pending = 'extract'
    clearTimeout(this.timer)
    return this.enqueue()
  }

  private enqueue(): Promise<void> {
    this.queue = this.queue.then(() => this.refresh())
    return this.queue
  }

  /** Does whatever was scheduled by the time the previous refresh finished. */
  private async refresh(): Promise<void> {
    const next = this.pending
    this.pending = undefined
    try {
      if (next === 'extract') await this.extract()
      else if (next === 'policy') this.rebuild()
    } catch (e) {
      console.error(e)
      this.emit({ type: 'status', message: `refresh failed: ${(e as Error).message}` })
    }
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
