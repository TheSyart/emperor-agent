#!/usr/bin/env node
// Computer Use end-to-end runner: bundles tests/electron/harness/main.ts to
// out-e2e/harness.cjs and runs it in real Electron (ELECTRON_RUN_AS_NODE
// removed, Emperor Home isolated), then summarises the E2E-RESULT lines.
//   node scripts/e2e-cu.mjs [--mode=smoke|contract|extra|userbrowser|fullstack|real|references|references-real|plugins|userbrowser-app|settings|renderer-security]
// `real` and `references-real` need EMPEROR_E2E_MODEL_CONFIG (a
// model_config.json to copy). `references` runs the E-track suite (reply
// links in a Build session); `references-real` asks a real model once.
// `plugins` runs the B-track acceptance (install, run and switch plugins in
// 能力 › 插件; GitHub's gh logged in, then out through an empty config dir).
// `userbrowser-app` runs the C-track acceptance (设置 › 浏览器, link routing,
// the browsing history and your own downloads in the real app). `settings`
// opens every settings section and sub page in the real app (F track).
// `renderer-security` checks the main window's CSP, permissions, link and
// remote image handling in the real app (SEC-05).
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

// fullstack / real / references / plugins / userbrowser-app / settings /
// renderer-security: the dev app
// (out/, run `npm run build` first) driven by Playwright from plain Node;
// the other modes run the harness in Electron.
const references =
  mode === '--mode=references' || mode === '--mode=references-real'
const plugins = mode === '--mode=plugins'
const userBrowserApp = mode === '--mode=userbrowser-app'
const settingsApp = mode === '--mode=settings'
const rendererSecurity = mode === '--mode=renderer-security'
const realModel = mode === '--mode=real' || mode === '--mode=references-real'
const appMode =
  mode === '--mode=fullstack' ||
  mode === '--mode=real' ||
  references ||
  plugins ||
  userBrowserApp ||
  settingsApp ||
  rendererSecurity
const entry = references
  ? 'tests/electron/references/run.ts'
  : plugins
    ? 'tests/electron/plugins/run.ts'
    : userBrowserApp
      ? 'tests/electron/user-browser-app/run.ts'
      : settingsApp
        ? 'tests/electron/settings/run.ts'
        : rendererSecurity
          ? 'tests/electron/renderer-security/run.ts'
          : appMode
            ? 'tests/electron/fullstack/run.ts'
            : 'tests/electron/harness/main.ts'
const bundle = references
  ? join(desktop, 'out-e2e', 'references.cjs')
  : plugins
    ? join(desktop, 'out-e2e', 'plugins.cjs')
    : userBrowserApp
      ? join(desktop, 'out-e2e', 'user-browser-app.cjs')
      : settingsApp
        ? join(desktop, 'out-e2e', 'settings.cjs')
        : rendererSecurity
          ? join(desktop, 'out-e2e', 'renderer-security.cjs')
          : appMode
            ? join(desktop, 'out-e2e', 'fullstack.cjs')
            : outfile

await build({
  entryPoints: [join(desktop, entry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  // The Claude Agent SDK is ESM-only and reads import.meta at load; the app
  // loads it unbundled too (app.asar.unpacked), so keep it external here.
  external: ['electron', 'playwright-core', '@anthropic-ai/claude-agent-sdk'],
  sourcemap: 'inline',
  logLevel: 'warning',
})

const home = mkdtempSync(join(tmpdir(), 'emperor-e2e-cu-'))
const env = { ...process.env, EMPEROR_CONFIG_DIR: home }
delete env.ELECTRON_RUN_AS_NODE
const child = appMode
  ? spawn(process.execPath, [bundle, ...(realModel ? ['--real'] : [])], {
      cwd: desktop,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
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
