import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { LoginShellEnvironment } from './login-shell'

/**
 * Emperor runs the user's installed, unmodified CLI (AGT-12): it ships no
 * Claude Code of its own. A bare name (`claude`, `codex`) is looked up on
 * PATH — the environment Emperor started with plus the usual install
 * folders (executorEnvironment: ~/.local/bin, /opt/homebrew/bin,
 * /usr/local/bin, …) — and then on the login shell's PATH, for a Dock
 * launch that does not see a folder ~/.zshrc adds. An absolute path is
 * used as it is.
 */
export function findExecutable(
  command: string,
  path: string | undefined,
): string | undefined {
  if (isAbsolute(command))
    return isExecutableFile(command) ? command : undefined
  if (!command || command.includes('/')) return undefined
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** {@link findExecutable}, then the login shell's PATH. */
export async function locateExecutable(
  command: string,
  options: { path?: string; loginShell?: LoginShellEnvironment },
): Promise<string | undefined> {
  const found = findExecutable(command, options.path)
  if (found || isAbsolute(command) || !options.loginShell) return found
  try {
    return findExecutable(
      command,
      (await options.loginShell.read(['PATH'])).PATH,
    )
  } catch {
    return undefined
  }
}

/** The official install command (code.claude.com/docs/en/setup, macOS). */
export const CLAUDE_INSTALL_COMMAND =
  'curl -fsSL https://claude.ai/install.sh | bash'
