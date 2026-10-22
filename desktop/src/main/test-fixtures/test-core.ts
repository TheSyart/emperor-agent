import type { CoreApiCreateOptions } from '@emperor/core/api'

/**
 * The toolchain probe of a Core a test starts: every `--version` answers at
 * once with no version, as on a machine without those tools. A real probe
 * starts a process per tool on PATH (git, gh, node, npm, uv, …), each allowed
 * 5 s; on loaded, throttled cores that alone outlasted a test's 5 s (FIX-17).
 */
export const QUIET_TOOLCHAIN: NonNullable<
  CoreApiCreateOptions['environmentProbeRunner']
> = {
  run: async () => ({
    status: 'completed',
    exitCode: 1,
    stdout: '',
    stderr: 'toolchain probes are not run in tests',
    durationMs: 0,
    error: null,
  }),
}
