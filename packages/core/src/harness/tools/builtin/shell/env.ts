/**
 * Shell environment (ported from dsh-shell-env + dsh-subprocess scrub +
 * dsh-bash-local `ENV_OVERRIDES`).
 *
 * Layering, last wins:
 * 1. base: `services.shellEnv?.()` or `process.env`, with credential-looking
 *    keys (KEY|PASSWORD|SECRET|TOKEN) and ambient managed keys removed;
 * 2. model-friendly terminal overrides (no colors, no pagers);
 * 3. managed `EMPEROR_*` facts for this call.
 *
 * Kept from dsh's `DSH_*` set: `EMPEROR_SHELL=1` (was `DSH_SHELL`),
 * `EMPEROR_SESSION_ID` (was `DSH_SESSION_ID`), plus `EMPEROR_WORKSPACE` (the
 * resolved session workspace root). Dropped: `DSH_HOME` and
 * `DSH_SESSION_JSONL` (Emperor Home / session storage layout are host
 * concerns the model should not reach around), and the contributor registry.
 * Only the managed keys are scrubbed from the base, so host settings such as
 * `EMPEROR_CONFIG_DIR` still pass through.
 */

export const EMPEROR_ENV_PREFIX = 'EMPEROR_'

export const MANAGED_ENV_KEYS = [
  'EMPEROR_SHELL',
  'EMPEROR_SESSION_ID',
  'EMPEROR_WORKSPACE',
] as const

/** Ambient keys that look like credentials are not inherited by model commands. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Terminal overrides that keep tool output free of colors and pagers. */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

export interface ManagedEnvFacts {
  sessionId?: string
  workspaceRoot?: string
}

export function managedEnv(facts: ManagedEnvFacts): Record<string, string> {
  return {
    EMPEROR_SHELL: '1',
    ...(facts.sessionId === undefined
      ? {}
      : { EMPEROR_SESSION_ID: facts.sessionId }),
    ...(facts.workspaceRoot === undefined
      ? {}
      : { EMPEROR_WORKSPACE: facts.workspaceRoot }),
  }
}

export function buildShellEnv(
  base: NodeJS.ProcessEnv,
  facts: ManagedEnvFacts,
): NodeJS.ProcessEnv {
  const managed = new Set<string>(MANAGED_ENV_KEYS)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (managed.has(key.toUpperCase())) continue
    env[key] = value
  }
  return { ...env, ...ENV_OVERRIDES, ...managedEnv(facts) }
}
