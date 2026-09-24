import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { CallEdge, ImportEdge, IrModule } from '../core/ir.ts'

export interface Extraction {
  modules: IrModule[]
  imports: ImportEdge[]
  calls: CallEdge[]
  warnings: string[]
}

/** One per language. Extractors own their module ids; ids never collide across languages. */
export interface Extractor {
  name: string
  /** File extensions whose change should trigger re-extraction. */
  extensions: string[]
  /** Other files whose change should too (configs). */
  configFiles: RegExp
  /** Async because some extractors talk to a language server (Pyright). */
  extract(root: string): Promise<Extraction>
}

/** Directories no extractor descends into. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.ak-review',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.next',
  '.turbo',
])

export function isIgnoredPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => IGNORED_DIRS.has(segment))
}

/** Repo-relative, forward-slash path. */
export function toModuleId(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/')
}

/**
 * Repo-relative paths of the files worth analyzing. In a git repo that is what git tracks
 * plus untracked files not ignored, so generated bundles and scratch output under
 * .gitignore stay out. Elsewhere, a walk that skips ignored and hidden directories.
 */
export function listRepoFiles(root: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return out.split('\0').filter((f) => f !== '' && !isIgnoredPath(f) && existsSync(join(root, f)))
  } catch {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(join(dir, entry.name))
          }
        } else if (entry.isFile()) {
          files.push(toModuleId(root, join(dir, entry.name)))
        }
      }
    }
    walk(root)
    return files
  }
}

export function countLoc(text: string): number {
  let loc = 0
  for (const line of text.split('\n')) if (line.trim() !== '') loc++
  return loc
}
