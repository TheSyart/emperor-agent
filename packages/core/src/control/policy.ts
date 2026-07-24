/**
 * ControlPolicy (MIG-CTRL-002)。对齐 Python `agent/control/policy.py`。
 * 经 PermissionPipeline.isToolExposed 暴露工具；plan 模式过滤 definitions。
 */
import { PermissionPipeline } from '../permissions/pipeline'
import type { ToolRegistry } from '../tools/registry'
import type { ToolDefinition } from '../tools/base'
import { ControlMode } from './models'

export const CONTROL_TOOL_NAMES = new Set([
  'ask_user',
  'propose_plan',
  'complete_plan_step',
])

interface PolicyHost {
  readonly mode: string
  hasExecutablePlan?(): boolean
  shouldExposeUpdateTodos?(): boolean
}

export class ControlPolicy {
  private readonly manager: PolicyHost
  readonly permissionPipeline: PermissionPipeline

  constructor(manager: PolicyHost) {
    this.manager = manager
    this.permissionPipeline = new PermissionPipeline()
  }

  isToolAllowed(name: string, registry: ToolRegistry): boolean {
    return this.permissionPipeline.isToolExposed(name, this.manager.mode, {
      registry,
    })
  }

  filteredDefinitions(registry: ToolRegistry): ToolDefinition[] {
    const definitions = registry.getDefinitions()
    if (this.manager.mode !== ControlMode.PLAN) {
      const hasExecutablePlan = this.manager.hasExecutablePlan?.() ?? false
      const exposeUpdateTodos = this.manager.shouldExposeUpdateTodos?.() ?? true
      return definitions.filter(
        (item) =>
          item.name !== 'propose_plan' &&
          (item.name !== 'complete_plan_step' || hasExecutablePlan) &&
          (item.name !== 'update_todos' || exposeUpdateTodos),
      )
    }
    // 已在计划模式：request_plan_mode 没有意义，与 propose_plan 的可见性互补
    return definitions.filter(
      (item) =>
        item.name !== 'request_plan_mode' &&
        item.name !== 'complete_plan_step' &&
        this.isToolAllowed(String(item.name ?? ''), registry),
    )
  }
}
