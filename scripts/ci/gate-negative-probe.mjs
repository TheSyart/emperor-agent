#!/usr/bin/env node
// REL-04 test 1: the PR gate fails on a build whose seal was taken away.
// Copies the packaged app three times, breaks one SEC-04 guarantee in each
// copy, and runs the packaged smoke on it; each run must fail before the app
// starts, with the reason the seal check gives. The copies live in the
// system temp directory and are removed afterwards; nothing is installed.
//
//   node scripts/ci/gate-negative-probe.mjs [--app "<path>/Emperor Agent.app"] [--list]
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const desktop = join(repoRoot, 'desktop')
const CODESIGN = '/usr/bin/codesign'
const DITTO = '/usr/bin/ditto'

export const VARIANTS = [
  {
    id: 'signature-removed',
    expect: 'code object is not signed at all',
    break: (app) => run(CODESIGN, ['--remove-signature', app]),
  },
  {
    id: 'no-hardened-runtime',
    expect: 'lacks the hardened runtime',
    // The outer app sealed again ad hoc, same entitlements, no runtime flag.
    break: (app) =>
      run(CODESIGN, [
        '--force',
        '--sign',
        '-',
        '--timestamp=none',
        '--entitlements',
        previewEntitlements().app,
        app,
      ]),
  },
  {
    id: 'run-as-node-fuse',
    expect: 'RunAsNode is true, expected false',
    // RunAsNode back on, then the whole app sealed again exactly as
    // after-pack does: only the fuse is wrong.
    break: async (app) => {
      const { FuseV1Options, FuseVersion, flipFuses } =
        desktopRequire('@electron/fuses')
      await flipFuses(app, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: false,
        [FuseV1Options.RunAsNode]: true,
      })
      desktopRequire('./scripts/harden-package.cjs').sealMacApp(
        app,
        previewEntitlements(),
      )
    },
  },
]

function desktopRequire(id) {
  return createRequire(join(desktop, 'package.json'))(id)
}

function previewEntitlements() {
  return desktopRequire('./scripts/after-pack.cjs').PREVIEW_ENTITLEMENTS
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    )
  return result.stdout
}

function defaultApp() {
  const dist = join(desktop, 'dist')
  const apps = existsSync(dist)
    ? readdirSync(dist, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
        .map((entry) => join(dist, entry.name, 'Emperor Agent.app'))
        .filter(existsSync)
    : []
  if (apps.length !== 1)
    throw new Error(
      `expected exactly one desktop/dist/mac*/Emperor Agent.app, found ${apps.length}; pass --app`,
    )
  return apps[0]
}

/** Runs the packaged smoke on one broken copy; it must refuse it. */
async function probe(variant, sealedApp) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-unsealed-')))
  const app = join(work, 'Emperor Agent.app')
  try {
    run(DITTO, [sealedApp, app])
    await variant.break(app)
    const smoke = spawnSync(
      process.execPath,
      [
        join(desktop, 'scripts', 'run-packaged-smoke.cjs'),
        '--app',
        join(app, 'Contents', 'MacOS', 'Emperor Agent'),
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180_000 },
    )
    const output = `${smoke.stdout}\n${smoke.stderr}`
    // The runner keeps its workspace on failure; it is ours to remove.
    const kept = /smoke workspace retained for inspection: (.+)$/m.exec(output)
    const keptPath = kept ? kept[1].trim() : ''
    if (
      keptPath &&
      existsSync(keptPath) &&
      realpathSync(keptPath).startsWith(realpathSync(tmpdir()) + sep)
    )
      rmSync(keptPath, { recursive: true, force: true })
    const refused =
      smoke.status !== 0 &&
      output.includes(variant.expect) &&
      !output.includes('packaged smoke passed') &&
      // Refused at the seal check, before the app was started.
      output.includes('packaged app seal is invalid')
    return {
      id: variant.id,
      ok: refused,
      exitCode: smoke.status,
      detail: refused
        ? `refused: ${variant.expect}`
        : `not refused as expected (${variant.expect}):\n${output.trim().slice(-2000)}`,
    }
  } catch (error) {
    return { id: variant.id, ok: false, exitCode: null, detail: error.message }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function main(argv) {
  if (argv.includes('--list')) {
    console.log(
      JSON.stringify(VARIANTS.map(({ id, expect }) => ({ id, expect }))),
    )
    return 0
  }
  if (process.platform !== 'darwin') {
    console.error('gate-negative-probe: macOS only')
    return 1
  }
  const index = argv.indexOf('--app')
  const sealedApp = resolve(index >= 0 ? argv[index + 1] : defaultApp())
  if (!existsSync(join(sealedApp, 'Contents', 'MacOS', 'Emperor Agent')))
    throw new Error(`not an Emperor Agent.app: ${sealedApp}`)
  console.log(`unsealed copies of ${sealedApp}`)
  let failed = 0
  for (const variant of VARIANTS) {
    const result = await probe(variant, sealedApp)
    if (!result.ok) failed++
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.id}: ${result.detail}`,
    )
  }
  if (failed) {
    console.error(`${failed} unsealed copy(ies) got past the packaged gate`)
    return 1
  }
  console.log('the packaged gate refused every unsealed copy')
  return 0
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    },
  )
