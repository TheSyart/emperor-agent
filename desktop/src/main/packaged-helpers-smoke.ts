/**
 * SEC-04 test 9: the packaged helpers still start and talk to Emperor under
 * the hardened runtime. The Computer Use helper goes through the desktop
 * driver, the path Settings and the Agent use: it installs the bundled helper
 * into native-helpers/<cdhash>/ (resealed ad hoc with the runtime), starts it
 * through LaunchServices and completes the socket handshake. The dictation
 * helper is verified, started as Emperor's child and must answer hello and
 * status. Neither asks for a permission: the handshake reads Accessibility
 * and Screen Recording with the preflight calls, and status reads the
 * microphone and speech recognition states without requesting them.
 */

export interface PackagedHelpersSmokeReceipt {
  ok: boolean
  mode: 'macos' | 'not-macos'
  computerUse: { handshake: boolean; hardenedCopy: boolean }
  dictation: { available: boolean }
}

export interface PackagedHelpersSmokeDeps {
  /** The driver's status: connects (installs, launches, handshakes) if needed. */
  computerHelperStatus(): Promise<{
    connected: boolean
    protocol: number | null
    /** Why it is offline (the driver's own words), for the failure message. */
    reason?: string
    lastErrorCode?: string | null
  }>
  /** The verified installed copy the driver runs (installation is idempotent). */
  installedComputerHelper(): Promise<string>
  identity(path: string): Promise<{ adHoc: boolean; runtime: boolean }>
  /** Shuts the helper down. */
  release(): Promise<void>
  /** Removes the smoke's copy from LaunchServices. */
  forget(installed: string): Promise<void>
  dictationStatus(): Promise<{ available: boolean; engine: string | null }>
}

export async function verifyPackagedHelpers(
  deps: PackagedHelpersSmokeDeps,
): Promise<PackagedHelpersSmokeReceipt> {
  const failed: string[] = []
  let handshake = false
  let hardenedCopy = false
  let installed: string | null = null
  try {
    const status = await deps.computerHelperStatus()
    handshake = status.connected === true && status.protocol !== null
    if (!handshake)
      failed.push(
        `computer-use-handshake (${status.reason ?? status.lastErrorCode ?? 'not connected'})`,
      )
    installed = await deps.installedComputerHelper()
    const identity = await deps.identity(installed)
    hardenedCopy = identity.adHoc ? identity.runtime : true
    if (!hardenedCopy) failed.push('computer-use-runtime')
  } catch (error) {
    failed.push(`computer-use-handshake (${(error as Error).message})`)
  } finally {
    await deps.release().catch(() => undefined)
    if (installed)
      await deps.forget(installed).catch((error: Error) => {
        failed.push(`computer-use-unregister (${error.message})`)
      })
  }
  let available = false
  try {
    const status = await deps.dictationStatus()
    available = status.available === true && Boolean(status.engine)
  } catch {
    available = false
  }
  if (!available) failed.push('dictation')
  if (failed.length)
    throw new Error(`packaged helper smoke failed: ${failed.join(', ')}`)
  return {
    ok: true,
    mode: 'macos',
    computerUse: { handshake, hardenedCopy },
    dictation: { available },
  }
}
