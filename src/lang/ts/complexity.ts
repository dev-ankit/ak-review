import ts from '@typescript/typescript6'

const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/**
 * McCabe cyclomatic complexity: 1 + one per branch point (if, ?:, loop, case, catch,
 * short-circuit operator). Nested closures count toward the enclosing function; they are
 * reviewed as part of it.
 */
export function complexity(node: ts.Node): number {
  let n = 1
  const visit = (x: ts.Node): void => {
    switch (x.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.CaseClause:
        n++
        break
      case ts.SyntaxKind.BinaryExpression:
        if (LOGICAL.has((x as ts.BinaryExpression).operatorToken.kind)) n++
        break
    }
    ts.forEachChild(x, visit)
  }
  ts.forEachChild(node, visit)
  return n
}
