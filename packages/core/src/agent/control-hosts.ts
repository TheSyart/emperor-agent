/**
 * AgentLoop 的两个 ControlManagerRunnerHost 工厂（W7：从 loop.ts 下沉）。
 */
import type { ControlManager } from '../control/manager'
import type { ControlManagerRunnerHost } from './runner'

export function dispatchControlHost(control: ControlManager): {
  mode?: string
  [key: string]: unknown
} {
  return {
    get mode(): string {
      return control.mode
    },
  } as { mode?: string; [key: string]: unknown }
}

/**
 * 子代理/Team 成员的 AgentRunner 控件宿主：只透传权限评估（工具审批闸门必须
 * 覆盖子进程，否则 dispatch_subagent/Team 成为审批系统的旁路），不透传
 * Ask-Guard/Plan 起草——那些是面向主对话的交互式功能，子代理"独立上下文、
 * 只回传总结"的设计不应把用户拉进子代理内部的澄清/计划流程。
 */
export function permissionOnlyControlHost(
  control: ControlManager,
): ControlManagerRunnerHost {
  return {
    systemPrompt: () => '',
    toolDefinitions: (registry) => control.toolDefinitions(registry),
    assessPermission: (name, args, registry) =>
      control.assessPermission(name, args, registry),
    permissionApprovalResult: (decision, opts) =>
      control.permissionApprovalResult(decision as never, opts),
    assessClarification: () => ({
      required: false,
      reason: '',
      questions: [],
      categories: [],
    }),
    shouldEnforcePlanFinal: () => false,
    createAsk: (opts) => control.createAsk(opts),
    createPlanFromText: (text, meta) => control.createPlanFromText(text, meta),
  }
}
