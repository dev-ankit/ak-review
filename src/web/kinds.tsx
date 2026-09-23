import {
  Box,
  Braces,
  FileCode,
  Folder,
  Parentheses,
  type LucideIcon,
  SquareDashed,
  SquareFunction,
  Type,
  Variable,
} from 'lucide-react'

import type { NodeKind } from '../core/model.ts'

export const KIND_ICON: Record<NodeKind, LucideIcon> = {
  component: Folder,
  module: FileCode,
  class: Box,
  interface: SquareDashed,
  type: Type,
  enum: Braces,
  function: SquareFunction,
  method: Parentheses,
  variable: Variable,
}

export const KIND_LABEL: Record<NodeKind, string> = {
  component: 'component',
  module: 'module',
  class: 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  function: 'function',
  method: 'method',
  variable: 'variable',
}

export function KindIcon({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  const Icon = KIND_ICON[kind]
  return <Icon size={size} className={`kind-icon kind-${kind}`} aria-label={KIND_LABEL[kind]} />
}
