/**
 * macOS: keep a folder out of Time Machine with `tmutil addexclusion`. The
 * exclusion is sticky (stored on the folder itself) and needs no
 * administrator rights. Used for the Agent's persistent browser profiles,
 * whose sign-ins Chromium keeps (SEC-10). Other systems: nothing.
 */
import { execFile as nodeExecFile } from 'node:child_process'

type ExecFileLike = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
) => void

export function createBackupExclusion(
  options: { platform?: NodeJS.Platform; execFile?: ExecFileLike } = {},
): (path: string) => Promise<void> {
  const platform = options.platform ?? process.platform
  const run: ExecFileLike =
    options.execFile ??
    ((file, args, callback) => {
      nodeExecFile(file, [...args], { timeout: 10_000 }, (error) =>
        callback(error),
      )
    })
  return (path) => {
    if (platform !== 'darwin') return Promise.resolve()
    return new Promise((resolve, reject) => {
      run('/usr/bin/tmutil', ['addexclusion', path], (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }
}
