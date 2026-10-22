#!/usr/bin/env node
// SEC-04 probes of a packaged macOS Emperor: each tries one way of running
// foreign code with Emperor's identity and must find it closed.
//
//   npm run package:probe -- [--app "<path>/Emperor Agent.app"]
//
// Every launch uses a synthetic HOME (CFFIXED_USER_HOME too) and a temp state
// root. Launches that a hardened build must refuse carry the smoke flag
// without a receipt, so a hardened build exits 64 before it touches any
// state; an unhardened build shows the hole instead. Nothing is installed,
// no permission is requested, and the user's ~/.emperor is never used.
const { spawn, spawnSync } = require('node:child_process')
const {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { createConnection } = require('node:net')
const { tmpdir, userInfo } = require('node:os')
const { join, resolve } = require('node:path')
const { getRawHeader } = require('@electron/asar')

const desktopRoot = resolve(__dirname, '..')
const app = resolveApp(process.argv.slice(2))
const main = join(app, 'Contents', 'MacOS', 'Emperor Agent')
const helpers = join(app, 'Contents', 'Library', 'Helpers')
const work = mkdtempSync(join(tmpdir(), 'emperor-hardening-probe-'))
const REFUSED = 64

function resolveApp(argv) {
  const index = argv.indexOf('--app')
  const explicit = index >= 0 ? argv[index + 1] : ''
  const path = resolve(
    explicit ||
      join(
        desktopRoot,
        'dist',
        process.arch === 'x64' ? 'mac' : 'mac-arm64',
        'Emperor Agent.app',
      ),
  )
  if (process.platform !== 'darwin' || !existsSync(path))
    throw new Error(`no macOS package at ${path}`)
  return path
}

function sandboxEnv(extra = {}) {
  const root = mkdtempSync(join(work, 'run-'))
  const home = join(root, 'home')
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(home, { recursive: true })
  return {
    root,
    env: {
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: root,
      EMPEROR_CONFIG_DIR: join(root, 'state'),
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      ...extra,
    },
  }
}

function launch(executable, args, env, { timeoutMs = 20_000, onOutput } = {}) {
  return new Promise((done) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const take = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-65_536)
      onOutput?.(output)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      done({ code, signal, output })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      done({ code: null, signal: null, output: String(error) })
    })
  })
}

function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

async function watchPort(port, untilDone) {
  let open = false
  while (!untilDone()) {
    if (await portOpen(port)) open = true
    await new Promise((wait) => setTimeout(wait, 100))
  }
  return open
}

const marker = (name) => join(work, `${name}.ran`)

const probes = {
  async 'run-as-node (1)'() {
    const mark = marker('run-as-node')
    const { env } = sandboxEnv({ ELECTRON_RUN_AS_NODE: '1', PROBE_MARK: mark })
    const result = await launch(
      main,
      [
        '-e',
        "require('fs').writeFileSync(process.env.PROBE_MARK, '1'); console.log('RUN_AS_NODE')",
        // After `--`, Node passes it to the script; the app still sees it.
        '--',
        '--emperor-packaged-smoke',
      ],
      env,
    )
    return {
      ok: !existsSync(mark) && result.code === REFUSED,
      detail: `exit ${result.code}, script ran: ${existsSync(mark)}`,
    }
  },

  async 'NODE_OPTIONS --require (2)'() {
    const script = join(work, 'node-options.js')
    const markNode = marker('node-options-node')
    const markApp = marker('node-options-app')
    writeFileSync(
      script,
      "require('fs').writeFileSync(process.env.PROBE_MARK, '1'); process.exit(0)\n",
    )
    const asNode = sandboxEnv({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--require=${script}`,
      PROBE_MARK: markNode,
    })
    const nodeResult = await launch(
      main,
      ['-e', '0', '--', '--emperor-packaged-smoke'],
      asNode.env,
    )
    const asApp = sandboxEnv({
      NODE_OPTIONS: `--require=${script}`,
      PROBE_MARK: markApp,
    })
    const appResult = await launch(
      main,
      ['--emperor-packaged-smoke'],
      asApp.env,
    )
    return {
      ok:
        !existsSync(markNode) &&
        !existsSync(markApp) &&
        nodeResult.code === REFUSED &&
        appResult.code === REFUSED,
      detail: `node mode: exit ${nodeResult.code}, ran ${existsSync(markNode)}; app mode: exit ${appResult.code}, ran ${existsSync(markApp)}`,
    }
  },

  async '--inspect (3)'() {
    const port = 39_229
    const { env } = sandboxEnv()
    let finished = false
    const run = launch(
      main,
      [`--inspect=${port}`, '--emperor-packaged-smoke'],
      env,
    )
    const opened = watchPort(port, () => finished)
    const result = await run
    finished = true
    const open = await opened
    const listening = /Debugger listening/.test(result.output)
    return {
      ok: !open && !listening && result.code === REFUSED,
      detail: `exit ${result.code}, port opened: ${open}, "Debugger listening": ${listening}`,
    }
  },

  async 'remote debugging port and pipe'() {
    const port = 39_222
    const { env } = sandboxEnv()
    let finished = false
    const run = launch(
      main,
      [`--remote-debugging-port=${port}`, '--emperor-packaged-smoke'],
      env,
    )
    const opened = watchPort(port, () => finished)
    const result = await run
    finished = true
    const open = await opened
    const pipe = await launch(
      main,
      ['--remote-debugging-pipe', '--emperor-packaged-smoke'],
      sandboxEnv().env,
    )
    const listening = /DevTools listening/.test(result.output + pipe.output)
    return {
      ok:
        !open && !listening && result.code === REFUSED && pipe.code === REFUSED,
      detail: `port: exit ${result.code}, opened ${open}; pipe: exit ${pipe.code}; "DevTools listening": ${listening}`,
    }
  },

  async 'asar integrity (4)'() {
    const results = []
    for (const variant of ['content', 'header']) {
      const copy = join(mkdtempSync(join(work, 'asar-')), 'Emperor Agent.app')
      // A clone (APFS copy-on-write), so the package itself is untouched.
      const clone = spawnSync('/bin/cp', ['-cR', app, copy])
      if (clone.status !== 0) cpSync(app, copy, { recursive: true })
      const archive = join(copy, 'Contents', 'Resources', 'app.asar')
      const bytes = readFileSync(archive)
      const { headerSize } = getRawHeader(archive)
      // One byte: a letter of a log string in out/main/index.js, or a hex
      // digit of a recorded file hash in the header. An unhardened build
      // never reads either, so it still starts.
      if (variant === 'content') {
        const at = bytes.indexOf('failed to open external URL', 8 + headerSize)
        if (at < 0) return { ok: false, detail: 'content: no byte to change' }
        bytes[at + 1] ^= 0x20
      } else {
        const at = bytes.indexOf('"hash":"') + '"hash":"'.length
        if (at < 8 || at >= 8 + headerSize)
          return { ok: false, detail: 'header: no byte to change' }
        bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30
      }
      writeFileSync(archive, bytes)
      const smoke = sandboxEnv({
        EMPEROR_SMOKE_NODE: process.execPath,
        EMPEROR_SMOKE_NPM_CLI: process.env.npm_execpath || '',
      })
      const result = await launch(
        join(copy, 'Contents', 'MacOS', 'Emperor Agent'),
        [
          '--emperor-packaged-smoke',
          '--emperor-smoke-receipt',
          join(smoke.root, 'receipt.json'),
        ],
        smoke.env,
        { timeoutMs: 120_000 },
      )
      const refused = result.code !== 0 && /integrity/i.test(result.output)
      results.push({
        variant,
        refused,
        detail: `${variant} byte: exit ${result.code ?? result.signal}${refused ? ' (integrity check failed)' : ''}`,
      })
      rmSync(join(copy, '..'), { recursive: true, force: true })
    }
    return {
      ok: results.every((item) => item.refused),
      detail: results.map((item) => item.detail).join('; '),
    }
  },

  async 'DYLD_INSERT_LIBRARIES (5)'() {
    const architecture = spawnSync('/usr/bin/lipo', ['-archs', main], {
      encoding: 'utf8',
    })
    const arches = architecture.stdout.trim().split(/\s+/)
    if (
      architecture.status !== 0 ||
      arches.some((arch) => !['arm64', 'x86_64'].includes(arch))
    )
      return {
        ok: false,
        detail: 'could not determine the package architecture',
      }
    const targetArch = arches.includes(
      process.arch === 'x64' ? 'x86_64' : 'arm64',
    )
      ? process.arch === 'x64'
        ? 'x86_64'
        : 'arm64'
      : arches[0]
    const { collectRuntimeContext } =
      await import('../../scripts/ci/macos-runtime-context.mjs')
    const context = collectRuntimeContext({ architecture: targetArch })
    if (
      !context.controls.plain.injected ||
      context.controls.plain.error ||
      context.controls.hardened.error
    )
      return {
        ok: false,
        detail:
          'the injection control could not execute; no package result is valid',
      }
    const unenforced =
      /status: disabled\./.test(context.sip) &&
      context.controls.hardened.injected
    if (context.controls.hardened.injected && !unenforced)
      return {
        ok: false,
        detail:
          'the independent hardened control was injected despite the reported OS policy',
      }
    const source = join(work, 'inject.c')
    const dylib = join(work, 'inject.dylib')
    writeFileSync(
      source,
      [
        '#include <stdio.h>',
        '#include <stdlib.h>',
        '#include <unistd.h>',
        '__attribute__((constructor)) static void injected(void) {',
        '  const char *path = getenv("PROBE_MARK");',
        '  if (path) { FILE *f = fopen(path, "w"); if (f) { fputs("1", f); fclose(f); } }',
        '  _exit(0);',
        '}',
        '',
      ].join('\n'),
    )
    const build = spawnSync('/usr/bin/clang', [
      ...arches.flatMap((arch) => ['-arch', arch]),
      '-dynamiclib',
      '-o',
      dylib,
      source,
    ])
    if (build.status !== 0)
      return { ok: false, detail: `clang failed: ${build.stderr}` }
    const targets = {
      'Computer Helper': [
        join(
          helpers,
          'Emperor Computer Helper.app',
          'Contents',
          'MacOS',
          'emperor-computer-helper',
        ),
        [],
      ],
      'Dictation Helper': [
        join(
          helpers,
          'Emperor Dictation Helper.app',
          'Contents',
          'MacOS',
          'emperor-dictation-helper',
        ),
        [],
      ],
      'NM host': [join(helpers, 'emperor-nm-host'), []],
      app: [main, ['--emperor-packaged-smoke']],
    }
    const loaded = []
    const notExecuted = []
    for (const [label, [executable, args]] of Object.entries(targets)) {
      const mark = marker(`dyld-${label.replace(/\W/g, '-')}`)
      const { env } = sandboxEnv({
        DYLD_INSERT_LIBRARIES: dylib,
        PROBE_MARK: mark,
      })
      const result = await launch(executable, args, env, { timeoutMs: 10_000 })
      if (result.code === null && result.signal === null)
        notExecuted.push(label)
      if (existsSync(mark)) loaded.push(label)
    }
    if (notExecuted.length)
      return {
        ok: false,
        detail: `could not execute: ${notExecuted.join(', ')}`,
      }
    if (unenforced)
      return {
        unverified: true,
        detail: `SIP disabled; the independent hardened control also loaded the library. OS protection cannot be verified here. Observed package targets: ${loaded.join(', ') || 'none'}. Repeat on a SIP-enabled host.`,
      }
    return {
      ok: loaded.length === 0,
      detail: loaded.length
        ? `library loaded into: ${loaded.join(', ')}`
        : 'not loaded into the app, Computer Helper, Dictation Helper or NM host',
    }
  },

  async 'smoke only on temp state (7)'() {
    // A home outside the temp directory, standing in for the user's own.
    const home = mkdtempSync(join(desktopRoot, 'dist', '.probe-home-'))
    try {
      const result = await launch(
        main,
        [
          '--emperor-packaged-smoke',
          '--emperor-smoke-receipt',
          join(work, 'refused-receipt.json'),
        ],
        {
          HOME: home,
          CFFIXED_USER_HOME: home,
          TMPDIR: work,
          PATH: '/usr/bin:/bin',
        },
        { timeoutMs: 60_000 },
      )
      const touched = existsSync(join(home, '.emperor'))
      return {
        ok: result.code === REFUSED && !touched,
        detail: `exit ${result.code}, ~/.emperor written: ${touched}`,
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },

  async 'NM host runs hardened (9, partial)'() {
    const socket = join(
      userInfo().homedir,
      '.emperor',
      'run',
      `nm-${process.getuid()}.sock`,
    )
    if (existsSync(socket))
      return {
        ok: true,
        detail: 'skipped: an Emperor owns the Native Messaging socket',
      }
    const result = await launch(
      join(helpers, 'emperor-nm-host'),
      [`chrome-extension://${'a'.repeat(32)}/`],
      sandboxEnv().env,
      { timeoutMs: 10_000 },
    )
    const answered = /EMPEROR_NOT_RUNNING/.test(result.output)
    return {
      ok: answered,
      detail: answered
        ? 'answered EMPEROR_NOT_RUNNING (no Emperor running)'
        : `exit ${result.code}: ${result.output.slice(0, 200)}`,
    }
  },
}

async function mainProbe() {
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : null
  let failed = 0
  let unverified = 0
  let passed = 0
  console.log(`probing ${app}`)
  for (const [name, probe] of Object.entries(probes)) {
    if (only && !name.includes(only)) continue
    let result
    try {
      result = await probe()
    } catch (error) {
      result = { ok: false, detail: String(error?.message ?? error) }
    }
    if (result.unverified) unverified++
    else if (!result.ok) failed++
    else passed++
    console.log(
      `${result.unverified ? 'UNVERIFIED' : result.ok ? 'PASS' : 'FAIL'}  ${name}: ${result.detail}`,
    )
  }
  rmSync(work, { recursive: true, force: true })
  if (failed) {
    console.log(`${failed} hardening probe(s) failed`)
    process.exitCode = 1
  } else if (unverified) {
    console.log(
      `${passed} hardening probes passed; ${unverified} unverified because the OS does not enforce the independent runtime control`,
    )
    process.exitCode = 77
  } else console.log('all hardening probes passed')
}

mainProbe().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
