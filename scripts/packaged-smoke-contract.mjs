/** The current packaged smoke contract, shared by Preview release consumers. */
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
}
