/**
 * The intermediate representation an extractor run writes to `<repo>/.ak-review/ir.json`.
 *
 * The IR is raw topology: every module the extractors found, their symbols, and the
 * import and call edges between them. It is language-neutral; everything downstream of
 * the extractors (policy, model, views) only sees this shape. Agents edit the policy,
 * never the IR.
 */

export type Language = 'typescript' | 'javascript' | 'python'

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'variable'

/** 1-based, inclusive line span. */
export interface Range {
  start: number
  end: number
}

export interface IrSymbol {
  /** `<module id>#<name>`; members are `<module id>#<Class>.<member>`. */
  id: string
  name: string
  kind: SymbolKind
  exported: boolean
  range: Range
  /** Cyclomatic complexity of the body, nested closures included. Callables only. */
  complexity?: number
  children?: IrSymbol[]
}

export interface IrModule {
  /** Repo-relative path with forward slashes, e.g. `src/ui/App.tsx`. */
  id: string
  language: Language
  /** Non-blank lines. */
  loc: number
  symbols: IrSymbol[]
  /** Third-party packages this module imports (`react`, `@xyflow/react`, `node:fs`). */
  externals: string[]
}

export interface ImportEdge {
  from: string
  to: string
  /** Every import between the pair is type-only (erased at runtime). */
  typeOnly: boolean
}

export interface CallEdge {
  /** Calling symbol id, or a module id for top-level code. */
  from: string
  /** Called symbol id (a class for `new`, a component for JSX). */
  to: string
  /** Lines of each call site in the caller's module. */
  lines: number[]
}

export interface Ir {
  version: 1
  /** Absolute path of the analyzed repo. */
  root: string
  generatedAt: string
  modules: IrModule[]
  imports: ImportEdge[]
  calls: CallEdge[]
  /** Extractor problems worth surfacing, e.g. unreadable config. */
  warnings: string[]
}

/** The module id a symbol id belongs to. */
export function moduleOf(symbolId: string): string {
  const hash = symbolId.indexOf('#')
  return hash === -1 ? symbolId : symbolId.slice(0, hash)
}
