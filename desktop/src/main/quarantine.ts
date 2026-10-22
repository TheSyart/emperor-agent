/**
 * The macOS source mark on downloaded files (`com.apple.quarantine`), set
 * the way browsers do so Gatekeeper checks a file before it first runs.
 * Used for your own downloads (user-downloads.ts) and the Agent's inbox
 * (computer-use/download-inbox.ts, SEC-10).
 */
import { execFile as nodeExecFile } from 'node:child_process'

type ExecFileLike = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
) => void

/**
 * macOS: mark a finished download the way browsers do
 * (`com.apple.quarantine`), so Gatekeeper checks it before it first runs.
 * Other systems: nothing.
 */
export function createQuarantine(
  options: {
    platform?: NodeJS.Platform
    execFile?: ExecFileLike
    now?: () => number
  } = {},
): (path: string) => Promise<void> {
  const platform = options.platform ?? process.platform
  const run: ExecFileLike =
    options.execFile ??
    ((file, args, callback) => {
      nodeExecFile(file, [...args], (error) => callback(error))
    })
  const now = options.now ?? Date.now
  return (path) => {
    if (platform !== 'darwin') return Promise.resolve()
    const seconds = Math.floor(now() / 1000).toString(16)
    return new Promise((resolve, reject) => {
      run(
        '/usr/bin/xattr',
        ['-w', 'com.apple.quarantine', `0083;${seconds};Emperor Agent;`, path],
        (error) => (error ? reject(error) : resolve()),
      )
    })
  }
}
