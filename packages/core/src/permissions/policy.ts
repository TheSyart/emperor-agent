/**
 * PermissionPolicy (MIG-CTRL-016)。对齐 Python `agent/permissions/policy.py`。
 * PermissionPipeline 的向后兼容门面。
 */
import type { ToolRegistry } from '../tools/registry'
import type { PermissionDecision } from './models'
import { PermissionPipeline } from './pipeline'
import type { PermissionRuleInput } from './rules'
import type { ShellReadonlyContext } from './shell-ast'

interface PermissionAssessmentOptions extends ShellReadonlyContext {
  readonly registry?: ToolRegistry | null
}

export class PermissionPolicy {
  readonly pipeline: PermissionPipeline

  constructor(
    pipeline?: PermissionPipeline,
    opts: { rules?: PermissionRuleInput[] | null } = {},
  ) {
    this.pipeline =
      pipeline ?? new PermissionPipeline({ rules: opts.rules ?? [] })
  }

  assess(
    toolName: string,
    args: Record<string, unknown> | null | undefined,
    mode: string,
    opts?: PermissionAssessmentOptions,
  ): PermissionDecision {
    return this.pipeline.assess(toolName, args, mode, opts)
  }

  isToolExposed(
    toolName: string,
    mode: string,
    opts?: { registry?: ToolRegistry | null },
  ): boolean {
    return this.pipeline.isToolExposed(toolName, mode, opts)
  }
}
