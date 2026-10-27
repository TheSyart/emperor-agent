/**
 * The e2e suites never run, or even see, the user's real Claude Code and
 * Codex (AGT-02, AGT-12): the folders holding a claude or codex command are
 * dropped from PATH, and sign-ins are read from an empty folder under the
 * suite's home (EMPEROR_E2E_EXECUTOR_HOME) instead of ~/.claude or ~/.codex,
 * without the login shell that would bring PATH back. A suite that needs a
 * stand-in puts its own folder first afterwards.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_COMMANDS = ['claude', 'codex']

/** The folders on PATH that hold a claude or codex command. */
export function agentsOnPath(path: string): string[] {
  return path
    .split(':')
    .filter(
      (dir) =>
        dir !== '' &&
        AGENT_COMMANDS.some((name) => existsSync(join(dir, name))),
    )
}

/** PATH without the folders that hold a claude or codex command. */
export function pathWithoutAgents(path: string): string {
  return path
    .split(':')
    .filter(
      (dir) =>
        dir !== '' &&
        !AGENT_COMMANDS.some((name) => existsSync(join(dir, name))),
    )
    .join(':')
}

/** Keep the real Claude Code and Codex out of an app launched with `env`. */
export function isolateAgents(env: Record<string, string>, home: string): void {
  env.PATH = pathWithoutAgents(env.PATH ?? '')
  env.EMPEROR_E2E_EXECUTOR_HOME = join(home, 'executor-home')
  mkdirSync(env.EMPEROR_E2E_EXECUTOR_HOME, { recursive: true })
}
