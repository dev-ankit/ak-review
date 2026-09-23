import { useState } from 'react'

import { fmtName } from '../lib/reexport.ts'
import { createStore } from '../model/store.ts'
import * as fmt from './format.ts'
import { formatName } from './format.ts'

const store = createStore()

export function Title({ id }: { id: string }) {
  return <h1>{store.label(id)}</h1>
}

export const App = () => {
  const [n] = useState(0)
  store.add({ id: String(n), name: 'x' })
  return (
    <main>
      <Title id="1" />
      {fmt.formatName('y')}
      {formatName('z')}
      {fmtName('w')}
    </main>
  )
}
