/**
 * Services that built-in tools depend on. Each built-in tool module exports
 * a `create…Tool(services)` factory; the host composition builds one
 * `ToolServices` and registers the tools it wants.
 */

import type { ApprovalService } from '../approval/service'
import type { SandboxBackend } from '../sandbox/backend'
import type { SandboxPolicyService } from '../sandbox/policy'

export interface ToolServices {
  /** Per-session sandbox mode resolution (session override > default). */
  sandbox: SandboxPolicyService
  /** Wraps argv for confined modes; throws SANDBOX_UNAVAILABLE when unusable. */
  sandboxBackend: SandboxBackend
  /** User approval (sandbox escalation). */
  approval: ApprovalService
  /** Directory for spilled large outputs (created on demand). */
  spillRoot: string
  /**
   * Directory that stages atomic file writes (created on demand). Defaults to
   * Emperor Home's `write-staging`, so a temp file never surfaces inside the
   * user's project; a target on another filesystem still stages beside itself.
   */
  writeStagingRoot?: string
  /** Environment for shell tools (PATH etc.); defaults to process.env. */
  shellEnv?: () => NodeJS.ProcessEnv
  /** Resolve a bundled binary (e.g. ripgrep) path; undefined → rely on PATH. */
  resolveBinary?: (name: 'rg') => string | undefined
}
