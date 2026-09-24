import type { Node } from 'web-tree-sitter'

const BRANCHES = new Set([
  'if_statement',
  'elif_clause',
  'conditional_expression',
  'for_statement',
  'while_statement',
  'except_clause',
  'if_clause',
  'case_clause',
  // One per `and` / `or`: the grammar nests them as binary operators.
  'boolean_operator',
])

/**
 * McCabe cyclomatic complexity: 1 + one per branch point (if/elif, conditional expression,
 * loop, except, comprehension `if`, match `case`, `and`/`or`). Nested functions and lambdas
 * count toward the enclosing function, as in the TypeScript extractor.
 */
export function complexity(node: Node): number {
  let n = 1
  const visit = (x: Node): void => {
    for (const child of x.namedChildren) {
      if (BRANCHES.has(child.type)) n++
      visit(child)
    }
  }
  visit(node)
  return n
}
