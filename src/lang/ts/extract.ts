import { isAbsolute, join, posix, relative } from 'node:path'

import ts from '@typescript/typescript6'

import type { CallEdge, ImportEdge, IrModule, IrSymbol, SymbolKind } from '../../core/ir.ts'
import {
  countLoc,
  type Extraction,
  type Extractor,
  listRepoFiles,
  toModuleId,
} from '../extractor.ts'
import { complexity } from './complexity.ts'

/**
 * TypeScript/JavaScript extractor on the TypeScript 6 compiler API (TS 7 no longer exports
 * one). Every `tsconfig.json` / `jsconfig.json` in the repo seeds a program, project
 * references included; source files no config covers go into one loose program. Each file
 * is owned by the first program that lists it, and that program's type checker resolves
 * its calls.
 */

const SOURCE = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/
const DECLARATION = /\.d\.[^/]*ts$/
const SEED_CONFIG = /^(tsconfig|jsconfig)\.json$/

export const typescriptExtractor: Extractor = {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  configFiles: /(^|\/)((tsconfig|jsconfig)[^/]*\.json|package\.json)$/,
  extract: extractTypeScript,
}

interface Project {
  label: string
  fileNames: string[]
  options: ts.CompilerOptions
}

interface Owned {
  id: string
  sf: ts.SourceFile
  program: ts.Program
  cache: ts.ModuleResolutionCache
}

const LOOSE_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
}

export function extractTypeScript(root: string): Extraction {
  const warnings: string[] = []
  const files = listRepoFiles(root)
  const known = new Set(files)
  /** Module id of a file the repo tracks; undefined for node_modules, ignored or outside files. */
  const inRepo = (file: string): string | undefined => {
    const rel = relative(root, file)
    if (rel.startsWith('..') || isAbsolute(rel)) return undefined
    const id = rel.replaceAll('\\', '/')
    return known.has(id) ? id : undefined
  }
  const isSource = (file: string) => SOURCE.test(file) && !DECLARATION.test(file)

  const seeds = files.filter((f) => SEED_CONFIG.test(posix.basename(f))).map((f) => join(root, f))
  const projects = discoverProjects(root, seeds, warnings)
  const owned = new Map<string, Owned>()
  const unowned = (file: string) => {
    const id = inRepo(file)
    return id !== undefined && isSource(file) && !owned.has(id)
  }
  const own = (project: Project) => {
    const fresh = project.fileNames.filter(unowned)
    if (fresh.length === 0) return
    const program = ts.createProgram({
      rootNames: project.fileNames,
      options: { ...project.options, noEmit: true },
    })
    const cache = ts.createModuleResolutionCache(root, (f) => f, program.getCompilerOptions())
    for (const fileName of fresh) {
      const sf = program.getSourceFile(fileName)
      const id = inRepo(fileName)!
      if (sf) owned.set(id, { id, sf, program, cache })
      else warnings.push(`${project.label}: could not load ${id}`)
    }
  }
  for (const project of projects) own(project)
  own({
    label: 'loose files',
    fileNames: files.map((f) => join(root, f)).filter(unowned),
    options: LOOSE_OPTIONS,
  })

  // Pass 1: symbols. Declarations are keyed by `<module id>:<pos>` so a checker from any
  // program can map what it resolves back to a symbol id.
  const byKey = new Map<string, string>()
  const ownerOf = new Map<ts.Node, string>()
  const register = (moduleId: string, node: ts.Node, id: string) => {
    byKey.set(moduleId + ':' + node.pos, id)
    ownerOf.set(node, id)
  }
  const modules = new Map<string, IrModule>()
  for (const { id, sf } of owned.values()) {
    modules.set(id, {
      id,
      language: /\.[mc]?tsx?$/.test(id) ? 'typescript' : 'javascript',
      loc: countLoc(sf.text),
      symbols: extractSymbols(sf, id, (node, symbolId) => register(id, node, symbolId)),
      externals: [],
    })
  }

  const keyOf = (decl: ts.Node): string | undefined => {
    const fileName = decl.getSourceFile()?.fileName
    const id = fileName === undefined ? undefined : inRepo(fileName)
    return id === undefined ? undefined : id + ':' + decl.pos
  }

  // Pass 2: imports and calls.
  const imports = new Map<string, ImportEdge>()
  const calls = new Map<string, CallEdge>()
  for (const { id: moduleId, sf, program, cache } of owned.values()) {
    const checker = program.getTypeChecker()
    const options = program.getCompilerOptions()
    const externals = new Set<string>()
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

    const addImport = (specifier: ts.Node | undefined, typeOnly: boolean) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return
      const spec = specifier.text
      const resolved = ts.resolveModuleName(
        spec,
        sf.fileName,
        options,
        ts.sys,
        cache,
      ).resolvedModule
      const target = resolved ? inRepo(resolved.resolvedFileName) : undefined
      if (target !== undefined && owned.has(target)) {
        if (target === moduleId) return
        const key = moduleId + ' -> ' + target
        const edge = imports.get(key)
        if (edge) edge.typeOnly &&= typeOnly
        else imports.set(key, { from: moduleId, to: target, typeOnly })
      } else if (!spec.startsWith('.') && !spec.startsWith('/')) {
        externals.add(packageName(spec))
      }
    }

    const resolveCallee = (expr: ts.Node): string | undefined => {
      let e: ts.Node = expr
      while (
        ts.isParenthesizedExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isAsExpression(e) ||
        ts.isSatisfiesExpression(e)
      ) {
        e = e.expression
      }
      if (ts.isPropertyAccessExpression(e)) e = e.name
      let symbol = checker.getSymbolAtLocation(e)
      if (!symbol) return undefined
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
      for (const decl of symbol.declarations ?? []) {
        const key = keyOf(decl)
        const id = key === undefined ? undefined : byKey.get(key)
        if (id) return id
      }
      return undefined
    }

    const addCall = (from: string, to: string, at: number) => {
      if (from === to) return
      const key = from + ' -> ' + to
      const edge = calls.get(key)
      if (!edge) calls.set(key, { from, to, lines: [at] })
      else if (!edge.lines.includes(at)) edge.lines.push(at)
    }

    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) addImport(stmt.moduleSpecifier, importIsTypeOnly(stmt))
      else if (ts.isExportDeclaration(stmt)) addImport(stmt.moduleSpecifier, stmt.isTypeOnly)
      else if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference)
      )
        addImport(stmt.moduleReference.expression, stmt.isTypeOnly)
    }

    const visit = (node: ts.Node, owner: string): void => {
      owner = ownerOf.get(node) ?? owner
      let callee: ts.Node | undefined
      if (ts.isCallExpression(node)) {
        const [first] = node.arguments
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addImport(first, false)
        else if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
          addImport(first, false)
        else callee = node.expression
      } else if (ts.isNewExpression(node)) {
        callee = node.expression
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        callee = node.tagName
      }
      if (callee) {
        const target = resolveCallee(callee)
        if (target) addCall(owner, target, line(node))
      }
      ts.forEachChild(node, (child) => visit(child, owner))
    }
    visit(sf, moduleId)

    modules.get(moduleId)!.externals = [...externals].sort()
  }

  return {
    modules: [...modules.values()].sort((a, b) => a.id.localeCompare(b.id)),
    imports: [...imports.values()],
    calls: [...calls.values()],
    warnings,
  }
}

function discoverProjects(root: string, seeds: string[], warnings: string[]): Project[] {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) =>
      warnings.push(ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  }
  const queue = [...seeds]
  const seen = new Set<string>()
  const projects: Project[] = []
  while (queue.length > 0) {
    const configPath = queue.shift()!
    const key = configPath.replaceAll('\\', '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host)
    if (!parsed) {
      warnings.push(`could not read ${toModuleId(root, configPath)}`)
      continue
    }
    for (const ref of parsed.projectReferences ?? [])
      queue.push(ts.resolveProjectReferencePath(ref))
    if (parsed.fileNames.length > 0) {
      projects.push({
        label: toModuleId(root, configPath),
        fileNames: parsed.fileNames,
        options: parsed.options,
      })
    }
  }
  return projects
}

function importIsTypeOnly(stmt: ts.ImportDeclaration): boolean {
  const clause = stmt.importClause
  if (!clause) return false
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true
  if (clause.name) return false
  const named = clause.namedBindings
  return (
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((el) => el.isTypeOnly)
  )
}

function packageName(spec: string): string {
  if (spec.startsWith('node:')) return spec
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Top-level declarations and class members. Nested closures belong to their enclosing symbol. */
function extractSymbols(
  sf: ts.SourceFile,
  moduleId: string,
  register: (node: ts.Node, id: string) => void,
): IrSymbol[] {
  const taken = new Set<string>()
  const uniqueId = (base: string) => {
    let id = base
    for (let i = 2; taken.has(id); i++) id = `${base}~${i}`
    taken.add(id)
    return id
  }
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const range = (node: ts.Node) => ({ start: line(node.getStart(sf)), end: line(node.getEnd()) })

  // `export { a, b }` and `export default a` export names declared elsewhere in the file.
  const exportedNames = new Set<string>()
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          exportedNames.add((el.propertyName ?? el.name).text)
        }
      }
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      exportedNames.add(stmt.expression.text)
    }
  }
  const isExported = (stmt: ts.Statement, name: string) =>
    exportedNames.has(name) ||
    (ts.canHaveModifiers(stmt) &&
      (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false))

  const symbols: IrSymbol[] = []
  const add = (
    stmt: ts.Statement,
    decl: ts.Node,
    name: string,
    kind: SymbolKind,
    body?: ts.Node,
  ): IrSymbol => {
    const id = uniqueId(`${moduleId}#${name}`)
    register(decl, id)
    const symbol: IrSymbol = {
      id,
      name,
      kind,
      exported: isExported(stmt, name),
      range: range(stmt),
    }
    if (body) symbol.complexity = complexity(body)
    symbols.push(symbol)
    return symbol
  }

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.body) add(stmt, stmt, stmt.name?.text ?? 'default', 'function', stmt)
    } else if (ts.isClassDeclaration(stmt)) {
      const cls = add(stmt, stmt, stmt.name?.text ?? 'default', 'class')
      const children: IrSymbol[] = []
      for (const member of stmt.members) {
        const body = memberBody(member)
        const name = memberName(member)
        if (!body || name === undefined) continue
        const id = uniqueId(`${cls.id}.${name}`)
        register(member, id)
        children.push({
          id,
          name,
          kind: 'method',
          exported: cls.exported,
          range: range(member),
          complexity: complexity(body),
        })
      }
      if (children.length > 0) cls.children = children
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add(stmt, stmt, stmt.name.text, 'interface')
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add(stmt, stmt, stmt.name.text, 'type')
    } else if (ts.isEnumDeclaration(stmt)) {
      add(stmt, stmt, stmt.name.text, 'enum')
    } else if (ts.isVariableStatement(stmt)) {
      const single = stmt.declarationList.declarations.length === 1
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const fn = functionInitializer(decl.initializer)
        const symbol = add(stmt, decl, decl.name.text, fn ? 'function' : 'variable', fn)
        if (!single) symbol.range = range(decl)
      }
    }
  }
  return symbols
}

function memberName(member: ts.ClassElement): string | undefined {
  if (ts.isConstructorDeclaration(member)) return 'constructor'
  const name = member.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text
  }
  return undefined
}

function memberBody(member: ts.ClassElement): ts.Node | undefined {
  if (
    ts.isMethodDeclaration(member) ||
    ts.isConstructorDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return member.body ? member : undefined
  }
  if (ts.isPropertyDeclaration(member)) return functionInitializer(member.initializer)
  return undefined
}

/** `() => ...`, `function () {}`, or a wrapper call like `memo(() => ...)`. */
function functionInitializer(expr: ts.Expression | undefined): ts.Node | undefined {
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression
    }
    return e
  }
  if (!expr) return undefined
  const e = unwrap(expr)
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e
  if (ts.isCallExpression(e) && e.arguments.length > 0) {
    const arg = unwrap(e.arguments[0]!)
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg
  }
  return undefined
}
