import type { Model } from '../core/model.ts'

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export async function fetchModel(): Promise<Model> {
  return json<Model>(await fetch('/api/model'))
}

export async function fetchSource(file: string): Promise<string> {
  const body = await json<{ text: string }>(
    await fetch('/api/source?file=' + encodeURIComponent(file)),
  )
  return body.text
}

export async function refresh(): Promise<void> {
  await json(await fetch('/api/refresh', { method: 'POST' }))
}

/** Server events: a new model is ready, or a status line (extracting, failures). */
export function subscribe(onModel: () => void, onStatus: (message: string) => void): () => void {
  const source = new EventSource('/api/events')
  source.addEventListener('model', () => onModel())
  source.addEventListener('status', (e) => onStatus(JSON.parse(e.data).message))
  // A reconnect means the server restarted; its model may be newer than ours.
  source.addEventListener('open', () => onModel())
  return () => source.close()
}
