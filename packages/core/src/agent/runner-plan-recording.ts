/**
 * 计划证据/验证记录（W7：从 AgentRunner 下沉的协作者模块）。
 * 全部为容错自由函数：controlManager 缺失或方法不存在时静默跳过，
 * 与 runner 内原实现语义逐字一致。
 */
import type { ToolCallRequest } from '../providers/base'
import type { ToolResultObj } from '../tools/base'
import type { ToolRegistry } from '../tools/registry'
import { planToDict } from '../plans/models'
import { resultFromToolOutput, type VerificationCommand } from '../plans/verification'
import type { ControlManagerRunnerHost } from './runner'
import { discoveryEvidenceRefs, discoveryFiles, summarizeToolResult } from './runner-helpers'

type Msg = Record<string, unknown>

export function recordPlanDiscovery(cm: ControlManagerRunnerHost | null, call: ToolCallRequest, result: ToolResultObj): void {
  if (result.isError || cm === null || typeof cm.recordPlanDiscovery !== 'function') return
  const source = String(result.metadata.tool ?? call.name)
  if (source !== 'read_file' && source !== 'grep') return
  const files = discoveryFiles(source, result)
  if (source === 'grep' && !files.length) return
  const evidenceRefs = discoveryEvidenceRefs(source, result, files)
  try {
    cm.recordPlanDiscovery({
      source,
      summary: result.displaySummary || summarizeToolResult(result.modelContent, 240),
      files,
      evidenceRefs,
    })
  } catch {
    /* tolerate */
  }
}

export function recordPlanStepToolOutput(cm: ControlManagerRunnerHost | null, call: ToolCallRequest, result: ToolResultObj): void {
  if (cm === null || typeof cm.recordPlanStepToolOutput !== 'function') return
  try {
    cm.recordPlanStepToolOutput({
      toolName: call.name,
      summary: result.displaySummary || summarizeToolResult(result.modelContent, 240),
      toolCallId: call.id,
      artifacts: result.artifactPayloads(),
      metadata: result.metadata,
      isError: result.isError,
    })
  } catch {
    /* tolerate */
  }
}

/** update_todos 落地后把 todo 状态投影进执行中的计划（B1 完成路径）。容错：宿主缺失即跳过。 */
export function syncPlanTodoCompletion(cm: ControlManagerRunnerHost | null, todos: Array<Record<string, unknown>>, toolCallId: string): void {
  if (cm === null || typeof cm.syncPlanFromTodos !== 'function') return
  try {
    cm.syncPlanFromTodos(todos, { evidence: { source: 'update_todos', tool_call_id: toolCallId } })
  } catch {
    /* tolerate */
  }
}

export function planIndependentVerificationFollowup(cm: ControlManagerRunnerHost | null, registry: ToolRegistry): Record<string, unknown> | null {
  if (cm === null || typeof cm.planIndependentVerificationFollowup !== 'function') return null
  return cm.planIndependentVerificationFollowup({ dispatchAvailable: registry.get('dispatch_subagent') !== undefined })
}

export function planVerificationTarget(cm: ControlManagerRunnerHost | null, call: ToolCallRequest): Record<string, string> | null {
  if (call.name !== 'run_command' || cm === null) return null
  const command = call.arguments.command
  if (typeof command !== 'string' || typeof cm.planVerificationTarget !== 'function') return null
  return cm.planVerificationTarget(command)
}

export function recordPlanVerification(
  cm: ControlManagerRunnerHost | null,
  call: ToolCallRequest,
  content: string,
  target: Record<string, string> | null,
): { target: Record<string, string>; result: Record<string, unknown>; plan: Record<string, unknown> } | null {
  if (target === null || cm === null || typeof cm.recordPlanVerificationResult !== 'function') return null
  const command: VerificationCommand = { command: target.command!, cwd: null, timeoutSeconds: 300 }
  const resultObj = resultFromToolOutput(command, content)
  const result: Record<string, unknown> = {
    command: resultObj.command,
    exit_code: resultObj.exitCode,
    passed: resultObj.passed,
    summary: resultObj.summary,
    stdout_tail: resultObj.stdoutTail,
    stderr_tail: resultObj.stderrTail,
    checked_at: resultObj.checkedAt,
    source: 'run_command',
    tool_call_id: call.id,
  }
  if (target.requirement_id) {
    result.requirement_id = target.requirement_id
    result.verification_id = target.requirement_id
  }
  const plan = cm.recordPlanVerificationResult({ planId: target.plan_id!, stepId: target.step_id!, result })
  if (plan === null) return null
  return { target, result, plan: planToDict(plan) }
}

/** B4.2：领取未验证步骤并生成一次性诚实性 followup；宿主缺失或无未验证项返回 null。 */
export function unverifiedPlanHonestyFollowup(cm: ControlManagerRunnerHost | null): Msg | null {
  if (cm === null || typeof cm.claimUnverifiedPlanSteps !== 'function') return null
  let claim: { planId: string; steps: Array<{ id: string; title: string }> } | null = null
  try {
    claim = cm.claimUnverifiedPlanSteps()
  } catch {
    return null
  }
  if (claim === null) return null
  return {
    role: 'user',
    content: [
      '[PLAN_VERIFICATION_UNRECORDED]',
      `plan_id: ${claim.planId}`,
      `以下计划步骤的验证要求未记录任何执行证据：${claim.steps.map((step) => `${step.id}（${step.title}）`).join('、')}`,
      '',
      '要么现在执行对应的验证命令（结果会被自动记录），要么在最终答复中逐项明确声明「未验证」。不得声称已验证。',
    ].join('\n'),
  }
}

export function planVerificationFollowup(update: { result: Record<string, unknown>; target: Record<string, string> }): Msg | null {
  const result = update.result ?? {}
  if (result.passed !== false) return null
  const target = update.target ?? {}
  return {
    role: 'user',
    content: [
      '[PLAN_VERIFICATION_FAILED]',
      `plan_id: ${target.plan_id}`,
      `step_id: ${target.step_id}`,
      `command: ${result.command}`,
      `exit_code: ${result.exit_code}`,
      `summary: ${result.summary}`,
      '',
      '该计划步骤的验证命令失败。不要直接最终答复；先诊断失败原因，修复后重新执行相关验证。如果失败原因需要用户决策，调用 ask_user。',
    ].join('\n'),
  }
}
