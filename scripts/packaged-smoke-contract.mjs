import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { packagedFuses } = require('../desktop/scripts/harden-package.cjs')

const APP_IDENTIFIER = 'com.emperor.agent.desktop'
const SEALED_HELPERS = [
  'Computer Helper',
  'Dictation Helper',
  'Native Messaging host',
]

/**
 * The current packaged smoke contract, shared by the Preview and Stable
 * release consumers (desktop/scripts/run-packaged-smoke.cjs writes it).
 */
export function assertPackagedSmokeReceipt(receipt, identity) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.appVersion !== identity.appVersion ||
    receipt.commit !== identity.commit ||
    receipt.platform !== identity.platform ||
    receipt.arch !== identity.arch ||
    receipt.exitCode !== 0 ||
    receipt.stateRoot !== '$TEMP/stateRoot' ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeManifestHash || '') ||
    !/^[a-f0-9]{64}$/.test(receipt.runtimeRevision || '') ||
    receipt.installJobs?.before !== 0 ||
    receipt.installJobs?.after !== 0
  )
    throw new Error('packaged smoke identity or schema is invalid')

  const operations = receipt.operations
  for (const name of [
    'bootstrap',
    'diagnostics',
    'environment',
    'glob',
    'grep',
    'terminal',
    'seatbelt',
    'renderer',
  ]) {
    if (operations?.[name]?.ok !== true)
      throw new Error(`packaged smoke operation failed: ${name}`)
  }
  const sandbox = operations.diagnostics.sandbox
  const backend = {
    darwin: 'macos-seatbelt',
    linux: 'linux-bwrap',
    win32: 'windows-unsupported',
  }[receipt.platform]
  if (
    !backend ||
    sandbox?.backend !== backend ||
    sandbox.provenance !== 'host-os' ||
    !['available', 'unavailable', 'unsupported', 'error'].includes(
      sandbox.status,
    ) ||
    (receipt.platform === 'darwin' && sandbox.status !== 'available') ||
    (receipt.platform === 'win32' && sandbox.status !== 'unsupported')
  )
    throw new Error('packaged smoke host sandbox receipt is invalid')

  const lifecycle = operations.diagnostics.lifecycle
  const services = lifecycle?.readyServices
  if (
    lifecycle?.state !== 'ready' ||
    !Array.isArray(services) ||
    !['harness-kernel', 'mcp', 'process-runtime', 'scheduler'].every((name) =>
      services.includes(name),
    )
  )
    throw new Error('packaged smoke lifecycle receipt is incomplete')

  if (
    receipt.platform === 'darwin' &&
    (operations.seatbelt.mode !== 'workspace-write' ||
      !Number.isSafeInteger(operations.seatbelt.commands) ||
      operations.seatbelt.commands < 18 ||
      operations.seatbelt.protectedStateDenied !== true)
  )
    throw new Error('packaged smoke Seatbelt matrix is invalid')

  const renderer = operations.renderer
  if (
    renderer.nodeGlobalsAbsent !== true ||
    renderer.coreBridge !== true ||
    renderer.coreBootstrap !== true ||
    // REL-05: the renderer read the app's own version from main.
    renderer.appVersion !== receipt.appVersion ||
    renderer.deepLinkRenders !== true ||
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
    throw new Error('packaged smoke renderer sandbox receipt is invalid')

  assertPackagedSeal(receipt)
}

/**
 * SEC-04, held by the release side since REL-05: the runner checked the
 * package before launching it. Every platform: the fuses. macOS: the
 * ad-hoc seal verifies, every helper has the hardened runtime, and the
 * helpers answered from their hardened copies.
 */
function assertPackagedSeal(receipt) {
  const seal = receipt.package
  const expected = packagedFuses(receipt.platform)
  const wrong = Object.keys(expected).filter(
    (name) => seal?.fuses?.[name] !== expected[name],
  )
  if (wrong.length)
    throw new Error(
      `packaged smoke fuses are missing or wrong: ${wrong.join(', ')}`,
    )
  if (receipt.platform !== 'darwin') return
  if (
    seal.codesignStrict !== true ||
    seal.identifier !== APP_IDENTIFIER ||
    !Number.isSafeInteger(seal.sealedCode) ||
    seal.sealedCode < 1 ||
    SEALED_HELPERS.some((label) => seal.runtime?.[label] !== true)
  )
    throw new Error('packaged smoke seal receipt is invalid')
  const helpers = receipt.operations.helpers
  if (
    helpers?.ok !== true ||
    helpers.computerUse?.handshake !== true ||
    helpers.computerUse?.hardenedCopy !== true ||
    helpers.dictation?.available !== true
  )
    throw new Error('packaged smoke macOS helpers receipt is invalid')
}
