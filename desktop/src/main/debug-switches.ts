/**
 * Chromium switches that open a DevTools endpoint. No Electron fuse turns
 * them off, and through one any local process could drive the main window
 * and its IPC bridge with Emperor's identity (SEC-04, like RunAsNode and
 * --inspect, which the fuses close).
 */
/** EX_USAGE, as for a refused packaged smoke. */
export const DEBUG_SWITCH_REFUSED_EXIT = 64

export const REMOTE_DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
] as const

/** The switch a packaged app refuses to start with, if any. */
export function refusedDebugSwitch(options: {
  readonly isPackaged: boolean
  hasSwitch(name: string): boolean
}): string | null {
  if (!options.isPackaged) return null
  return (
    REMOTE_DEBUGGING_SWITCHES.find((name) => options.hasSwitch(name)) ?? null
  )
}
