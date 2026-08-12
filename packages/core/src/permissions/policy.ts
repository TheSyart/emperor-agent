/**
 * PermissionPolicy。
 * PermissionPipeline 的向后兼容门面。
 */
import type { ToolRegistry } from '../tools/registry'
import type { PermissionDecision } from './models'
import { PermissionPipeline } from './pipeline'
import type { PermissionRuleInput, PermissionRuleLayerInput } from './rules'
import type { ShellReadonlyContext } from './shell-ast'
import type { FileExecutionScope } from './workspace-policy'

interface PermissionAssessmentOptions extends ShellReadonlyContext {
  readonly registry?: ToolRegistry | null
  readonly fileExecutionScopes?: readonly FileExecutionScope[]
}

export class PermissionPolicy {
  readonly pipeline: PermissionPipeline

  constructor(
    pipeline?: PermissionPipeline,
    opts: {
      rules?: PermissionRuleInput[] | null
      layers?: PermissionRuleLayerInput[] | null
    } = {},
  ) {
    this.pipeline =
      pipeline ??
      new PermissionPipeline({
        rules: opts.rules ?? [],
        layers: opts.layers ?? [],
      })
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
