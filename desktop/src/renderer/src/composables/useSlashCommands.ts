import type { Ref } from 'vue'
import type {
  CommandDescriptor,
  CommandInvocationResult,
  CommandSurface,
} from '@emperor/core/api'
import { core } from '../api/http'
import {
  rankSlashPaletteItems,
  resolveSlashInvocation,
  buildSlashPaletteItems,
} from '../commands'
import type {
  BootstrapPayload,
  ChatSendPayload,
  GoalOperationResult,
  RuntimeGoalSummary,
  SessionInfo,
} from '../types'
import type { GoalCardAction } from '../runtime/goalRender'
import type { GoalCaptureStatus } from './goalCapture'
import { createComposerLifecycleController } from './composerLifecycle'

export interface SlashCommandDeps {
  boot: Ref<BootstrapPayload | null>
  busy: Ref<boolean>
  commandDescriptors: Ref<CommandDescriptor[]>
  resolveSessionId: () => Promise<string>
  sendMessage: (payload: string | ChatSendPayload) => boolean
  showToast: (message: string) => void
  refreshAll: () => Promise<void>
  openCommandSurface: (
    surface: CommandSurface,
    params?: Record<string, unknown>,
  ) => void | Promise<void>
  activateTransitionedSession: (session: SessionInfo) => Promise<void>
  currentGoal: () => RuntimeGoalSummary | null
  startGoal: (outcome: string) => Promise<GoalOperationResult>
  runGoalAction: (
    goalId: string,
    action: GoalCardAction,
    reason?: string,
  ) => Promise<GoalOperationResult>
  currentGoalCaptureStatus: () => GoalCaptureStatus
  armGoalCapture: () => { ok: boolean; error?: string }
  clearGoalCapture: () => void
  startCapturedGoal: (outcome: string) => Promise<GoalOperationResult>
}

export function useSlashCommands(deps: SlashCommandDeps) {
  const queuedPolls = new Map<string, ReturnType<typeof setTimeout>>()
  const lifecycle = createComposerLifecycleController({
    currentControl: () => deps.boot.value?.control,
    currentGoal: deps.currentGoal,
    currentGoalCaptureStatus: deps.currentGoalCaptureStatus,
    agentBusy: () => deps.busy.value,
    setPlanEnabled: async (enabled) => {
      await writeControlMode(
        enabled ? 'plan' : savedExecutionPermission(deps.boot.value?.control),
      )
    },
    cancelGoal: (goalId, reason) =>
      deps.runGoalAction(goalId, 'cancel', reason),
    armGoalCapture: deps.armGoalCapture,
    clearGoalCapture: deps.clearGoalCapture,
    startGoal: deps.startGoal,
    startCapturedGoal: deps.startCapturedGoal,
  })

  function submitFromComposer(payload: string | ChatSendPayload): void {
    const normalized: ChatSendPayload =
      typeof payload === 'string'
        ? { content: payload, attachments: [] }
        : {
            ...payload,
            content: String(payload.content ?? ''),
            attachments: payload.attachments ?? [],
          }
    if (normalized.delivery) {
      deps.sendMessage(normalized)
      return
    }
    const invocation = resolveSlashInvocation(
      normalized.content,
      deps.commandDescriptors.value,
    )
    if (!invocation) {
      deps.sendMessage(normalized)
      return
    }
    if (!invocation.descriptor) {
      showUnknownCommand(invocation.name)
      return
    }
    void executeSlashCommand(
      invocation.raw,
      invocation.descriptor,
      (normalized.attachments ?? []).map((attachment) => attachment.id),
    )
  }

  async function executeSlashCommand(
    rawInput: string,
    knownDescriptor?: CommandDescriptor,
    attachments: string[] = [],
  ): Promise<CommandInvocationResult | null> {
    const invocation = resolveSlashInvocation(
      rawInput,
      deps.commandDescriptors.value,
    )
    const descriptor = knownDescriptor ?? invocation?.descriptor ?? null
    if (!invocation || !descriptor) {
      showUnknownCommand(invocation?.name ?? rawInput.replace(/^\//, ''))
      return null
    }
    try {
      const request = {
        sessionId: await deps.resolveSessionId(),
        commandId: descriptor.id,
        rawInput: invocation.raw,
        invocationId: createInvocationId(),
        invocationSource: 'desktop',
        attachments,
      } as const
      const result = await core('commands.invoke', request)
      await projectInvocationResult(result)
      if (result.status === 'queued') scheduleQueuedResultPoll(request)
      return result
    } catch (error) {
      deps.showToast(displayError(error))
      return null
    }
  }

  function scheduleQueuedResultPoll(request: {
    sessionId: string
    commandId: string
    rawInput: string
    invocationId: string
    invocationSource: 'desktop'
    attachments: string[]
  }): void {
    if (queuedPolls.has(request.invocationId)) return
    const poll = async () => {
      try {
        const result = await core('commands.invoke', request)
        if (result.status === 'queued') {
          queuedPolls.set(
            request.invocationId,
            globalThis.setTimeout(poll, 750),
          )
          return
        }
        queuedPolls.delete(request.invocationId)
        await projectInvocationResult(result)
      } catch (error) {
        queuedPolls.delete(request.invocationId)
        deps.showToast(displayError(error))
      }
    }
    queuedPolls.set(request.invocationId, globalThis.setTimeout(poll, 750))
  }

  async function projectInvocationResult(
    result: CommandInvocationResult,
  ): Promise<void> {
    if (result.status === 'rejected') {
      deps.showToast(result.message)
      return
    }
    if (result.status === 'queued') {
      deps.showToast('命令已排队，将在当前任务结束后执行。')
      return
    }
    if (result.status === 'submitted') return
    if (result.status === 'opened') {
      await deps.openCommandSurface(result.surface, result.params)
      return
    }
    const receipt = result.receipt
    if (!receipt) return
    if (receipt.code === 'session_transitioned') {
      const session = receipt.data?.session as SessionInfo | undefined
      if (!session?.id) {
        deps.showToast('新会话已经创建，但返回结果缺少会话标识。')
        return
      }
      await deps.activateTransitionedSession(session)
      deps.showToast(receipt.message)
      return
    }
    if (
      receipt.code === 'model_activated' ||
      receipt.code === 'reasoning_updated' ||
      receipt.code === 'permission_mode_updated' ||
      receipt.code.startsWith('plan_') ||
      receipt.code.startsWith('goal_')
    )
      await deps.refreshAll()
    deps.showToast(
      receipt.replacementSyntax
        ? `${receipt.message} 新语法：${receipt.replacementSyntax}`
        : receipt.message,
    )
  }

  function showUnknownCommand(name: string): void {
    const candidates = rankSlashPaletteItems(
      buildSlashPaletteItems(deps.commandDescriptors.value),
      name,
    )
      .slice(0, 3)
      .map((item) => item.name)
    deps.showToast(
      candidates.length
        ? `未知命令 /${name}。你是否想输入：${candidates.join('、')}`
        : `未知命令 /${name}。输入 / 查看可用命令。`,
    )
  }

  async function setPermissionMode(
    mode: 'ask_before_edit' | 'smart_auto' | 'full_access',
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const data = await core('control.setPermissionMode', mode)
      if (deps.boot.value) deps.boot.value.control = data
      deps.showToast(`执行权限已切换为${permissionLabel(mode)}`)
      return { ok: true }
    } catch (error) {
      const message = displayError(error)
      deps.showToast(message)
      return { ok: false, error: message }
    }
  }

  async function writeControlMode(
    mode: 'ask_before_edit' | 'smart_auto' | 'full_access' | 'plan',
  ) {
    const data = await core('control.setMode', mode)
    if (deps.boot.value) deps.boot.value.control = data
    deps.showToast(
      `已切换为${mode === 'plan' ? '计划模式' : permissionLabel(mode)}`,
    )
    return data
  }

  async function setControlMode(
    mode: 'ask_before_edit' | 'smart_auto' | 'full_access' | 'plan',
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await writeControlMode(mode)
      return { ok: true }
    } catch (error) {
      const message = displayError(error)
      deps.showToast(message)
      return { ok: false, error: message }
    }
  }

  async function setPlanEnabled(
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const result = enabled
      ? await lifecycle.activatePlan()
      : await lifecycle.deactivatePlan()
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  return {
    submitFromComposer,
    executeSlashCommand,
    setControlMode,
    setPlanEnabled,
    setPermissionMode,
    activatePlan: lifecycle.activatePlan,
    activateGoalCapture: lifecycle.activateGoalCapture,
    startGoalWithLifecycle: lifecycle.startGoalWithLifecycle,
    dismissLifecycle: lifecycle.dismissLifecycle,
    reconcileTerminalGoal: lifecycle.reconcileTerminalGoal,
    lifecycleMode: lifecycle.mode,
  }
}

function createInvocationId(): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(16).slice(2)}`
  return `desktop_command_${suffix}`
}

function savedExecutionPermission(
  control: BootstrapPayload['control'] | undefined,
): 'ask_before_edit' | 'smart_auto' | 'full_access' {
  if (control?.mode === 'plan' && control.previous_mode)
    return control.previous_mode
  if (control?.mode === 'smart_auto' || control?.mode === 'full_access')
    return control.mode
  return 'ask_before_edit'
}

function permissionLabel(
  mode: 'ask_before_edit' | 'smart_auto' | 'full_access',
): string {
  if (mode === 'full_access') return '完全访问'
  if (mode === 'smart_auto') return '智能自动'
  return '询问确认'
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
