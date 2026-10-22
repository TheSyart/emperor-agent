/**
 * Where main.log, core.log and Crashpad's minidumps go (REL-01). The real
 * Emperor Home (no EMPEROR_CONFIG_DIR) logs to ~/Library/Logs/Emperor Agent;
 * a home chosen with EMPEROR_CONFIG_DIR (tests, e2e runs, the packaged
 * smoke, a second profile) keeps its logs inside it, in `<home>/logs`, so
 * such runs never write to the user's own log folder.
 */
import * as path from 'node:path'

export interface LogLocation {
  dir: string
  mainLog: string
  coreLog: string
  crashDumps: string
  /** `default`: the user's log folder; `state-root`: inside the home. */
  source: 'default' | 'state-root'
}

export function resolveLogLocation(input: {
  stateRoot: string
  stateRootSource: string
  homeDir: string
  platform: NodeJS.Platform
  /** `app.getPath('logs')`, used off macOS. */
  systemLogs?: string
}): LogLocation {
  const inHome = input.stateRootSource !== 'default'
  const dir = inHome
    ? path.join(input.stateRoot, 'logs')
    : input.platform === 'darwin' || !input.systemLogs
      ? path.join(input.homeDir, 'Library', 'Logs', 'Emperor Agent')
      : input.systemLogs
  return {
    dir,
    mainLog: path.join(dir, 'main.log'),
    coreLog: path.join(dir, 'core.log'),
    crashDumps: path.join(dir, 'Crashpad'),
    source: inHome ? 'state-root' : 'default',
  }
}
