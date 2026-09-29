#!/usr/bin/env node
// Computer Use end-to-end runner: bundles tests/electron/harness/main.ts to
// out-e2e/harness.cjs and runs it in real Electron (ELECTRON_RUN_AS_NODE
// removed, Emperor Home isolated), then summarises the E2E-RESULT lines.
//   node scripts/e2e-cu.mjs [--mode=smoke|contract|extra|fullstack|real]
// `real` needs EMPEROR_E2E_MODEL_CONFIG (a model_config.json to copy).
// In --mode=overlay, EMPEROR_E2E_PHYSICAL_OVERLAY=1 waits up to 45 seconds
// for a real click on the visible stop button instead of clicking via JS.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const electronBinary = require('electron')
const mode =
  process.argv.find((arg) => arg.startsWith('--mode=')) ?? '--mode=smoke'
const outfile = join(desktop, 'out-e2e', 'harness.cjs')

// fullstack / real: the dev app (out/, run `npm run build` first) driven by
// Playwright from plain Node; the other modes run the harness in Electron.
const appMode = mode === '--mode=fullstack' || mode === '--mode=real'
const entry = appMode
  ? 'tests/electron/fullstack/run.ts'
  : 'tests/electron/harness/main.ts'
const bundle = appMode ? join(desktop, 'out-e2e', 'fullstack.cjs') : outfile

await build({
  entryPoints: [join(desktop, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  external: ['electron', 'playwright-core'],
  sourcemap: 'inline',
  logLevel: 'warning',
})

const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-cu-'))
const env = { ...process.env, EMPEROR_CONFIG_DIR: home }
delete env.ELECTRON_RUN_AS_NODE
const child = appMode
  ? spawn(
      process.execPath,
      [bundle, ...(mode === '--mode=real' ? ['--real'] : [])],
      {
        cwd: desktop,
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
  : spawn(electronBinary, [outfile, mode], {
      cwd: desktop,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
const results = []
let buffer = ''
let done = false
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.startsWith('E2E-RESULT ')) {
      const result = JSON.parse(line.slice('E2E-RESULT '.length))
      results.push(result)
      const mark = result.ok ? '✓' : '✗'
      console.log(
        `${mark} [${result.suite}] ${result.name} (${result.ms}ms)${result.ok ? (result.detail === undefined ? '' : ` ${JSON.stringify(result.detail)}`) : ` — ${result.error ?? JSON.stringify(result.detail)}`}`,
      )
    } else if (line === 'E2E-DONE') done = true
  }
})
const timeout = setTimeout(() => {
  console.error('e2e: timed out after 10 minutes')
  child.kill('SIGKILL')
}, 10 * 60_000)
const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
clearTimeout(timeout)
rmSync(home, { recursive: true, force: true })
const failed = results.filter((result) => !result.ok)
console.log(
  `\n${results.length - failed.length}/${results.length} passed (${mode.slice(7)})${done ? '' : ' — harness did not finish'}`,
)
process.exit(failed.length === 0 && done && code === 0 ? 0 : 1)
