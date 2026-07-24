#!/usr/bin/env node

const { spawn } = require('node:child_process')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const desktopRoot = resolve(__dirname, '..')
const repoRoot = resolve(desktopRoot, '..')
const appPath = resolveAppPath(process.argv.slice(2))
const tempRoot = mkdtempSync(join(tmpdir(), 'emperor-packaged-smoke-'))
const stateRoot = join(tempRoot, 'state')
const homeRoot = join(tempRoot, 'home')
const emptyBin = join(tempRoot, 'empty-bin')
const appDataRoot = join(homeRoot, 'AppData', 'Roaming')
const localAppDataRoot = join(homeRoot, 'AppData', 'Local')
const receiptPath = join(tempRoot, 'receipt.json')
mkdirSync(stateRoot, { recursive: true })
mkdirSync(homeRoot, { recursive: true })
mkdirSync(emptyBin, { recursive: true })
mkdirSync(appDataRoot, { recursive: true })
mkdirSync(localAppDataRoot, { recursive: true })

const args = [
  '--emperor-packaged-smoke',
  '--emperor-smoke-receipt',
  receiptPath,
]
if (process.platform === 'linux') {
  args.unshift('--headless', '--disable-gpu', '--ozone-platform=headless')
  args.unshift('--no-sandbox')
}

run(appPath, args, smokeEnvironment()).then(
  ({ code, stdout, stderr }) => {
    try {
      if (code !== 0)
        throw new Error(
          `packaged smoke exited ${code}\n${bounded(stderr || stdout)}`,
        )
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      validateReceipt(receipt)
      const outputDir = join(desktopRoot, 'dist', 'packaged-smoke')
      const outputPath = join(
        outputDir,
        `${receipt.platform}-${receipt.arch}.json`,
      )
      mkdirSync(outputDir, { recursive: true })
      writeAtomic(outputPath, receipt)
      console.log(`packaged smoke passed: ${outputPath}`)
      rmSync(tempRoot, { recursive: true, force: true })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      console.error(`smoke workspace retained for inspection: ${tempRoot}`)
      process.exitCode = 1
    }
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(`smoke workspace retained for inspection: ${tempRoot}`)
    process.exitCode = 1
  },
)

function resolveAppPath(argv) {
  const explicitIndex = argv.indexOf('--app')
  const explicit =
    explicitIndex >= 0 ? String(argv[explicitIndex + 1] || '').trim() : ''
  if (explicit) {
    const value = resolve(explicit)
    if (!existsSync(value)) throw new Error(`packaged app not found: ${value}`)
    return value
  }
  const envPath = String(process.env.EMPEROR_SMOKE_APP || '').trim()
  if (envPath) return resolveAppPath(['--app', envPath])

  const distRoot = join(desktopRoot, 'dist')
  let candidates = []
  if (process.platform === 'darwin') {
    candidates = readdirSync(distRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
      .map((entry) =>
        join(
          distRoot,
          entry.name,
          'Emperor Agent.app',
          'Contents',
          'MacOS',
          'Emperor Agent',
        ),
      )
  } else if (process.platform === 'win32') {
    candidates = [join(distRoot, 'win-unpacked', 'Emperor Agent.exe')]
  } else {
    candidates = [join(distRoot, 'linux-unpacked', 'emperor-agent')]
  }
  const existing = candidates.filter(existsSync)
  if (existing.length !== 1)
    throw new Error(
      `expected exactly one unpacked app for ${process.platform}/${process.arch}; found ${existing.length}`,
    )
  return existing[0]
}

function smokeEnvironment() {
  const env = {
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    EMPEROR_CONFIG_DIR: stateRoot,
    EMPEROR_BUILD_COMMIT: readGitCommit(repoRoot),
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    APPDATA: join(homeRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(homeRoot, 'AppData', 'Local'),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    ...(process.env.APPIMAGE_EXTRACT_AND_RUN === '1'
      ? { APPIMAGE_EXTRACT_AND_RUN: '1' }
      : {}),
    PATH: emptyBin,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
  for (const name of ['COMSPEC', 'PROGRAMDATA', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function run(executable, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: tempRoot,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) =>
      bounded(current + Buffer.from(chunk).toString('utf8'))
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('packaged smoke timed out after 60 seconds'))
    }, 60_000)
    timer.unref()
  })
}

function validateReceipt(receipt) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.exitCode !== 0 ||
    receipt.stateRoot !== '$TEMP/stateRoot' ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeManifestHash || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeRevision || '') ||
    receipt.installJobs?.before !== 0 ||
    receipt.installJobs?.after !== 0
  )
    throw new Error('packaged smoke receipt is invalid')
  for (const name of [
    'bootstrap',
    'diagnostics',
    'environment',
    'glob',
    'grep',
    'terminal',
    'renderer',
  ]) {
    if (receipt.operations?.[name]?.ok !== true)
      throw new Error(`packaged smoke operation failed: ${name}`)
  }
  const renderer = receipt.operations.renderer
  if (
    renderer.nodeGlobalsAbsent !== true ||
    renderer.coreBridge !== true ||
    renderer.coreBootstrap !== true ||
    renderer.attachment?.ok !== true ||
    !Number.isSafeInteger(renderer.attachment?.bytes) ||
    renderer.attachment.bytes <= 0 ||
    renderer.webPreferences?.sandbox !== true ||
    renderer.webPreferences?.contextIsolation !== true ||
    renderer.webPreferences?.nodeIntegration !== false ||
    !['enabled', 'disabled-for-linux-test'].includes(
      renderer.chromiumSandbox,
    ) ||
    (renderer.chromiumSandbox === 'disabled-for-linux-test' &&
      receipt.platform !== 'linux')
  )
    throw new Error('packaged renderer sandbox receipt is invalid')
  const body = JSON.stringify(receipt)
  if (
    body.includes(tempRoot) ||
    body.includes(homeRoot) ||
    body.includes(process.env.HOME || '__no_home__') ||
    body.includes(process.env.PATH || '__no_path__')
  )
    throw new Error('packaged smoke receipt contains private host paths')
}

function writeAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function readGitCommit(root) {
  try {
    const gitDir = join(root, '.git')
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[a-f0-9]{40}$/i.test(head)) return head.toLowerCase()
    if (!head.startsWith('ref: ')) return 'local'
    const ref = head.slice(5).trim()
    const loose = join(gitDir, ...ref.split('/'))
    if (existsSync(loose)) {
      const value = readFileSync(loose, 'utf8').trim()
      if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase()
    }
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    const line = packed
      .split(/\r?\n/)
      .find((value) => value.endsWith(` ${ref}`))
    const value = line?.split(' ')[0] || ''
    return /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : 'local'
  } catch {
    return 'local'
  }
}

function bounded(value) {
  const max = 1024 * 1024
  return value.length <= max ? value : value.slice(value.length - max)
}
