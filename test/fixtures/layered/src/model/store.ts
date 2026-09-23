import type { Item } from './types.ts'
import { formatName } from '../ui/format.ts'

export class Store {
  private items: Item[] = []

  add(item: Item): void {
    if (!item.id) throw new Error('id')
    this.items.push(item)
  }

  find(id: string): Item | undefined {
    return this.items.find((i) => i.id === id)
  }

  label = (id: string) => formatName(this.find(id)?.name ?? '')
}

export function createStore(): Store {
  return new Store()
}
