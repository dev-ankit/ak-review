import { execFileSync, execSync, spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package as users get it: pack (which builds), install the tarball into a scratch
 * project with npm, then run the installed CLI against a copy of the test fixture:
 * --version, extract, and serve (UI page plus the model API).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'ak-review-smoke-'))
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8' })
/** pnpm and npm are `.cmd` shims on Windows, which only run through a shell. */
const runShim = (cmd: string, args: string[], cwd: string) =>
  execSync([cmd, ...args.map((a) => `"${a}"`)].join(' '), { cwd, encoding: 'utf8' })

try {
  console.log('packing…')
  runShim('pnpm', ['pack', '--pack-destination', scratch], root)
  const tarball = readdirSync(scratch).find((f) => f.endsWith('.tgz'))!

  const app = join(scratch, 'app')
  cpSync(join(root, 'test', 'fixtures', 'layered'), join(app, 'repo'), { recursive: true })
  writeFileSync(join(app, 'package.json'), '{ "name": "smoke", "private": true }\n')
  console.log('installing…')
  runShim('npm', ['install', '--no-audit', '--no-fund', join(scratch, tarball)], app)

  const cli = join(app, 'node_modules', 'ak-review', 'dist', 'cli.js')
  const version = run('node', [cli, '--version'], app).trim()
  check(version.startsWith('ak-review v'), `--version printed "${version}"`)

  const extracted = run('node', [cli, 'extract', 'repo'], app)
  check(/extracted 6 modules/.test(extracted), `extract output:\n${extracted}`)

  await smokeServe(cli, app)
  console.log('smoke ok')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

async function smokeServe(cli: string, cwd: string): Promise<void> {
  const server = spawn('node', [cli, 'serve', 'repo', '--no-open', '--port', '4491'], { cwd })
  try {
    const url = await new Promise<string>((ok, fail) => {
      let out = ''
      const timer = setTimeout(() => fail(new Error(`serve did not start:\n${out}`)), 30_000)
      const read = (chunk: Buffer) => {
        out += chunk
        const match = /local:\s+(\S+)/.exec(out)
        if (match) {
          clearTimeout(timer)
          ok(match[1]!)
        }
      }
      server.stdout.on('data', read)
      server.stderr.on('data', read)
    })
    const page = await fetch(url)
    check(page.ok && (await page.text()).includes('<title>ak-review'), 'serve: UI page')
    const model = (await (await fetch(url + 'api/model')).json()) as { name: string }
    check(model.name === 'repo', 'serve: /api/model')
  } finally {
    server.kill()
  }
}

function check(ok: boolean, what: string): asserts ok {
  if (!ok) {
    console.error(`FAILED: ${what}`)
    process.exit(1)
  }
  console.log(`  ok  ${what.split('\n')[0]}`)
}
