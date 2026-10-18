import { execFile } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'

/**
 * Variables exported by the user's login shell (AGT-03, SUB-24; shared with
 * AGT-02). An app started from the Dock or Finder inherits launchd's
 * environment, not `~/.zshrc`, so a provider key the user exported there is
 * invisible to `process.env`. The shell runs once per requested name set,
 * with a short timeout and stdin closed; only the requested names are kept.
 */
export interface LoginShellEnvironment {
  read(names: readonly string[]): Promise<Record<string, string>>
}

const MARKER = '__EMPEROR_LOGIN_ENV__'

function loginShell(environment: NodeJS.ProcessEnv): string {
  const shell = environment.SHELL
  return shell && isAbsolute(shell) && ['zsh', 'bash'].includes(basename(shell))
    ? shell
    : '/bin/zsh'
}

export function createLoginShellEnvironment(
  options: {
    /** Defaults to the user's zsh or bash login shell, else /bin/zsh. */
    shell?: string
    environment?: NodeJS.ProcessEnv
    timeoutMs?: number
  } = {},
): LoginShellEnvironment {
  const environment = options.environment ?? process.env
  const shell = options.shell ?? loginShell(environment)
  const cache = new Map<string, Promise<Record<string, string>>>()
  const run = (names: string[]) =>
    new Promise<Record<string, string>>((resolve) => {
      execFile(
        shell,
        [
          '-ilc',
          `printf '\\0${MARKER}\\0'; /usr/bin/env -0; printf '\\0${MARKER}\\0'`,
        ],
        {
          env: environment,
          timeout: options.timeoutMs ?? 3000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          const parts = String(stdout ?? '').split('\0' + MARKER + '\0')
          if (error || parts.length < 3) return resolve({})
          const wanted = new Set(names),
            found: Record<string, string> = {}
          for (const entry of parts[1]!.split('\0')) {
            const at = entry.indexOf('=')
            if (at <= 0) continue
            const name = entry.slice(0, at)
            if (wanted.has(name)) found[name] = entry.slice(at + 1)
          }
          resolve(found)
        },
      ).stdin?.end()
    })
  return {
    read(names) {
      const wanted = [...new Set(names)]
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))
        .sort()
      if (!wanted.length) return Promise.resolve({})
      const key = wanted.join('\0')
      let pending = cache.get(key)
      if (!pending) {
        pending = run(wanted)
        cache.set(key, pending)
      }
      return pending.then((found) => ({ ...found }))
    },
  }
}
