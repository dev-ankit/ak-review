import type { Node } from 'web-tree-sitter'

import type { IrSymbol, SymbolKind } from '../../core/ir.ts'
import { complexity } from './complexity.ts'

/**
 * Called for every symbol: `scope` is the node whose code belongs to it (decorators
 * included), `name` the identifier a go-to-definition lands on, `isDef` whether it is a
 * `def` (a function or method, which Pyright's call hierarchy covers).
 */
export type Register = (scope: Node, name: Node, id: string, isDef: boolean) => void

/** Blocks that run at import time; definitions inside them are still module-level. */
const TRANSPARENT = new Set([
  'block',
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'finally_clause',
  'with_statement',
])

/**
 * Module-level functions, classes (methods as children), variables and type aliases,
 * including those under a top-level `if`, `try` or `with`. Nested functions belong to
 * their enclosing symbol. Exported means listed in `__all__` when the module has one, and
 * not `_`-prefixed otherwise.
 */
export function extractSymbols(root: Node, moduleId: string, register: Register): IrSymbol[] {
  const statements = moduleStatements(root)
  const all = dunderAll(statements)
  const isExported = (name: string) => (all ? all.has(name) : !name.startsWith('_'))

  const taken = new Set<string>()
  const uniqueId = (base: string) => {
    let id = base
    for (let i = 2; taken.has(id); i++) id = `${base}~${i}`
    taken.add(id)
    return id
  }
  const range = (node: Node) => ({
    start: node.startPosition.row + 1,
    end: node.endPosition.row + 1,
  })

  const symbols: IrSymbol[] = []
  for (const stmt of statements) {
    const def = definition(stmt)
    if (def?.type === 'function_definition') {
      const name = def.childForFieldName('name')!
      const id = uniqueId(`${moduleId}#${name.text}`)
      register(stmt, name, id, true)
      symbols.push({
        id,
        name: name.text,
        kind: 'function',
        exported: isExported(name.text),
        range: range(stmt),
        complexity: complexity(def),
      })
    } else if (def?.type === 'class_definition') {
      const name = def.childForFieldName('name')!
      const cls: IrSymbol = {
        id: uniqueId(`${moduleId}#${name.text}`),
        name: name.text,
        kind: 'class',
        exported: isExported(name.text),
        range: range(stmt),
      }
      register(stmt, name, cls.id, false)
      const children: IrSymbol[] = []
      for (const member of def.childForFieldName('body')?.namedChildren ?? []) {
        const fn = definition(member)
        if (fn?.type !== 'function_definition') continue
        const memberName = fn.childForFieldName('name')!
        const id = uniqueId(`${cls.id}.${memberName.text}`)
        register(member, memberName, id, true)
        children.push({
          id,
          name: memberName.text,
          kind: 'method',
          exported: cls.exported && (!memberName.text.startsWith('_') || isDunder(memberName.text)),
          range: range(member),
          complexity: complexity(fn),
        })
      }
      if (children.length > 0) cls.children = children
      symbols.push(cls)
    } else if (stmt.type === 'type_alias_statement') {
      const left = stmt.childForFieldName('left')
      const name = left?.type === 'type' ? left.namedChildren[0] : left
      if (name?.type !== 'identifier') continue
      const id = uniqueId(`${moduleId}#${name.text}`)
      register(stmt, name, id, false)
      symbols.push({
        id,
        name: name.text,
        kind: 'type',
        exported: isExported(name.text),
        range: range(stmt),
      })
    } else if (stmt.type === 'expression_statement') {
      const assignment = stmt.namedChildren[0]
      const target = assignment?.childForFieldName('left')
      if (assignment?.type !== 'assignment' || target?.type !== 'identifier') continue
      if (isDunder(target.text)) continue
      const value = assignment.childForFieldName('right')
      const kind: SymbolKind = value?.type === 'lambda' ? 'function' : 'variable'
      const id = uniqueId(`${moduleId}#${target.text}`)
      register(stmt, target, id, false)
      const symbol: IrSymbol = {
        id,
        name: target.text,
        kind,
        exported: isExported(target.text),
        range: range(stmt),
      }
      if (value?.type === 'lambda') symbol.complexity = complexity(value)
      symbols.push(symbol)
    }
  }
  return symbols
}

/** The statements that run when the module is imported, flattened through if/try/with. */
export function moduleStatements(root: Node): Node[] {
  const out: Node[] = []
  const visit = (node: Node) => {
    for (const child of node.namedChildren) {
      if (TRANSPARENT.has(child.type)) visit(child)
      else out.push(child)
    }
  }
  visit(root)
  return out
}

/** The function or class a statement defines, looking through decorators. */
function definition(stmt: Node): Node | null {
  if (stmt.type === 'decorated_definition') return stmt.childForFieldName('definition')
  if (stmt.type === 'function_definition' || stmt.type === 'class_definition') return stmt
  return null
}

function isDunder(name: string): boolean {
  return name.length > 4 && name.startsWith('__') && name.endsWith('__')
}

/** Names in `__all__ = [...]` and `__all__ += [...]`; undefined when the module has none. */
function dunderAll(statements: Node[]): Set<string> | undefined {
  let names: Set<string> | undefined
  for (const stmt of statements) {
    const assignment = stmt.type === 'expression_statement' ? stmt.namedChildren[0] : undefined
    if (assignment?.type !== 'assignment' && assignment?.type !== 'augmented_assignment') continue
    if (assignment.childForFieldName('left')?.text !== '__all__') continue
    const value = assignment.childForFieldName('right')
    if (value?.type !== 'list' && value?.type !== 'tuple') continue
    names ??= new Set()
    for (const item of value.namedChildren) {
      if (item.type !== 'string') continue
      const content = item.namedChildren.find((c) => c.type === 'string_content')
      if (content) names.add(content.text)
    }
  }
  return names
}
