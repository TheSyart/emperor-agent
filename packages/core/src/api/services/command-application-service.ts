import { randomUUID } from 'node:crypto'
import { PERMISSION_PRESET_VALUES } from '../../commands/builtins'
import type { CommandExecutionContext } from '../../commands/platform'
import type { ParsedCommandInput } from '../../commands/parser'
import type { SessionTransitionService } from '../../commands/session-transition'
import type {
  CommandCompletion,
  CommandInvocationResult,
} from '../../commands/types'
import type { CoreModelService } from './model-service'
import type { SkillInfoPayload } from './skill-service'

/** One selectable permission preset (mirrors `PermissionPresetService.options()`). */
export interface CommandPermissionPreset {
  value: string
  name: string
  description?: string
}

/** Outcome of a user plan-mode switch (mirrors `PlanModeController.set`). */
export type CommandPlanSwitchOutcome =
  'committed' | 'queued' | 'cancelled' | 'noop'

/** Result of the harness `/goal` command (mirrors `GoalCommandResult`). */
export interface CommandGoalResult {
  kind: 'success' | 'error'
  text: string
}

export interface CommandPromptSubmission {
  sessionId: string
  content: string
  displayContent: string
  clientMessageId: string
  delivery: 'queue'
  source: 'command'
  attachmentIds: string[]
}

/** A `context: fork` skill command, run as a forked subagent of the session. */
export interface CommandSkillFork {
  sessionId: string
  skillName: string
  task: string
  /** Child tool allow-list (empty: the parent's full tool set). */
  allowedTools: string[]
  /** Reasoning effort for the child's requests (null: inherit). */
  effort: string | null
}

/**
 * Everything the slash-command use cases need, expressible from
 * `HarnessHost` + `CoreModelService` + the session transition service.
 */
export interface CommandApplicationServiceDeps {
  models: Pick<CoreModelService, 'getConfig'>
  sessionTransitions: Pick<SessionTransitionService, 'clear'>
  getSession(sessionId: string): { id: string } | null
  skillsForSession(sessionId: string): SkillInfoPayload[]
  sessionBusy(sessionId: string): boolean
  /** `host.compactNow(sessionId)`. */
  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; shadowedTokenCount?: number }>
  /** `host.stop(sessionId)`: true when a running turn was cancelled. */
  stop(sessionId: string): boolean
  activateModel(entryId: string): Promise<unknown>
  setReasoningEffort(entryId: string, effort: string): Promise<unknown>
  /** `host.setPermissionPreset(sessionId, preset)`; returns the control payload. */
  setPermissionPreset(
    sessionId: string,
    preset: string,
  ): Record<string, unknown> | void
  /** `host.presets.options()`. */
  presets(): CommandPermissionPreset[]
  /** `host.controlPayload(sessionId)`. */
  controlPayload(sessionId: string): Record<string, unknown>
  /** `host.setPlanMode(sessionId, active)`. */
  setPlanMode(sessionId: string, active: boolean): CommandPlanSwitchOutcome
  /** `runGoalCommand(host.goals, host.agentFor(sessionId), rawInput)`. */
  runGoalCommand(sessionId: string, rawInput: string): CommandGoalResult
  /** Queue one user prompt (`host.submit`); resolves when its turn ends. */
  submitPrompt(input: CommandPromptSubmission): Promise<unknown>
  /** Start a forked skill subagent (`host.subagents.start(root, {mode:'fork'})`). */
  forkSkill(input: CommandSkillFork): { subagentId: string }
}

/** Session-explicit application use cases behind the slash-command platform. */
export class CoreCommandApplicationService {
  private readonly deps: CommandApplicationServiceDeps

  constructor(deps: CommandApplicationServiceDeps) {
    this.deps = deps
  }

  sessionContext(sessionId: string): { exists: boolean } {
    return { exists: Boolean(this.deps.getSession(sessionId)) }
  }

  skillsForSession(sessionId: string): SkillInfoPayload[] {
    return this.deps.skillsForSession(sessionId)
  }

  sessionBusy(sessionId: string): boolean {
    return this.deps.sessionBusy(sessionId)
  }

  async complete(
    name: string,
    rawArgs: string,
    _cursor: number,
    _sessionId: string,
  ): Promise<CommandCompletion[]> {
    const query = String(rawArgs ?? '')
      .trim()
      .toLowerCase()
    if (name === 'model') {
      const config = await this.deps.models.getConfig()
      return config.models
        .filter((item) =>
          [item.entryId, item.modelId, item.effectiveDisplayName]
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
        .map((item) => ({
          value: item.entryId,
          label: item.effectiveDisplayName,
          description: `${item.provider} · ${item.modelId}`,
          kind: 'model',
        }))
    }
    if (name === 'reasoning') {
      const config = await this.deps.models.getConfig()
      return (config.current?.reasoningEfforts ?? [])
        .filter((value) => value.toLowerCase().includes(query))
        .map((value) => ({ value, label: value, kind: 'reasoning_effort' }))
    }
    if (name === 'permissions') {
      return this.permissionPresets()
        .filter((item) =>
          [item.value, item.name].join(' ').toLowerCase().includes(query),
        )
        .map((item) => ({
          value: item.value,
          label: item.name,
          ...(item.description ? { description: item.description } : {}),
          kind: 'permission_preset',
        }))
    }
    return []
  }

  async executeBuiltin(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const { descriptor, parsed, sessionId, invocationId } = context
    const name = descriptor.name
    const tail = parsed.args.join(' ').trim()

    if (name === 'new') {
      const result = await this.deps.sessionTransitions.clear({
        sessionId,
        invocationId,
      })
      return completed(context, 'session_transitioned', '已创建全新上下文。', {
        session: result.session as unknown as Record<string, unknown>,
        previousSessionId: sessionId,
      })
    }
    if (name === 'compact') {
      const result = await this.deps.compact(sessionId)
      return result.compacted
        ? completed(context, 'compacted', '当前会话已压缩并保留摘要。', {
            result,
          })
        : completed(context, 'nothing_to_compact', '当前会话无需压缩。', {
            result,
          })
    }
    if (name === 'stop') {
      const cancelled = this.deps.stop(sessionId)
      return completed(
        context,
        cancelled ? 'stop_requested' : 'nothing_running',
        cancelled ? '已请求停止当前任务。' : '当前没有正在运行的任务。',
      )
    }
    if (name === 'model' && tail) {
      const config = await this.deps.models.getConfig()
      const model = config.models.find(
        (item) => item.entryId === tail || item.modelId === tail,
      )
      if (!model) return rejected('model_not_found', `找不到模型：${tail}`)
      await this.deps.activateModel(model.entryId)
      return completed(
        context,
        'model_activated',
        `已切换到 ${model.effectiveDisplayName}。`,
      )
    }
    if (name === 'reasoning' && tail) {
      const config = await this.deps.models.getConfig()
      if (!config.current)
        return rejected('model_unavailable', '当前没有可用模型。')
      await this.deps.setReasoningEffort(config.current.entryId, tail)
      return completed(
        context,
        'reasoning_updated',
        `思考强度已切换为 ${tail}。`,
      )
    }
    if (name === 'permissions' && tail)
      return this.executePermissions(context, tail.toLowerCase())
    if (name === 'plan') return await this.executePlan(context)
    if (name === 'goal') return this.executeGoal(context)
    if (name === 'continue') {
      const promptId = this.schedulePrompt(context, 'continue')
      return { status: 'submitted', promptId }
    }
    if (descriptor.uiSurface)
      return {
        status: 'opened',
        surface: descriptor.uiSurface,
        params: {
          rawArgs: parsed.args.join(' '),
          options: parsed.options,
          invokedName: parsed.name,
          commandId: descriptor.id,
        },
      }
    return completed(context, 'completed', '命令已执行。')
  }

  /**
   * Inline skill commands become a `/skill-name task` user prompt; the
   * kernel's skill middleware resolves the gesture and injects the
   * instructions. `context: fork` skills run as a forked background
   * subagent narrowed by `allowed_tools` / `effort` (`agent` is ignored:
   * there are no AgentDefinitions; diagnostics report it).
   */
  async submitSkill(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const binding = context.descriptor.skill
    if (!binding)
      return rejected('skill_binding_missing', 'Skill 命令绑定缺失。')
    const task = rawTail(context.parsed)
    if (binding.context === 'fork') {
      if (context.attachments.length)
        return rejected(
          'skill_fork_attachments_unsupported',
          'fork Skill 不支持附件；请移除附件后重试。',
        )
      const { subagentId } = this.deps.forkSkill({
        sessionId: context.sessionId,
        skillName: binding.name,
        task,
        allowedTools: [...binding.allowedTools],
        effort: binding.effort,
      })
      return completed(
        context,
        'skill_forked',
        `Skill ${binding.name} 已在子代理中运行。`,
        { subagentId, skill: binding.name },
      )
    }
    const content = task ? `/${binding.name} ${task}` : `/${binding.name}`
    const promptId = this.schedulePrompt(context, content)
    return { status: 'submitted', promptId }
  }

  private permissionPresets(): CommandPermissionPreset[] {
    const presets = this.deps.presets()
    if (presets.length) return presets
    return PERMISSION_PRESET_VALUES.map((value) => ({ value, name: value }))
  }

  private executePermissions(
    context: CommandExecutionContext,
    value: string,
  ): CommandInvocationResult {
    if (value === 'status')
      return {
        status: 'opened',
        surface: 'permissions',
        params: {
          rawArgs: '',
          invokedName: context.parsed.name,
          commandId: context.descriptor.id,
        },
      }
    const preset = this.permissionPresets().find((item) => item.value === value)
    if (!preset)
      return rejected(
        'invalid_permission_preset',
        `权限预设必须是 ${this.permissionPresets()
          .map((item) => item.value)
          .join('、')} 之一。`,
      )
    const control =
      this.deps.setPermissionPreset(context.sessionId, preset.value) ??
      this.deps.controlPayload(context.sessionId)
    return completed(
      context,
      'permission_preset_updated',
      `执行权限已切换为 ${preset.name}。`,
      { preset: preset.value, control },
    )
  }

  /** dsh semantics: `/plan` enters plan mode, `/plan <message>` also submits it, `/plan off` leaves. */
  private async executePlan(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const message = rawTail(context.parsed)
    if (message.toLowerCase() === 'off') {
      const outcome = this.deps.setPlanMode(context.sessionId, false)
      return completed(context, 'plan_disabled', planMessage(outcome, false), {
        outcome,
        control: this.deps.controlPayload(context.sessionId),
      })
    }
    const outcome = this.deps.setPlanMode(context.sessionId, true)
    if (!message)
      return completed(context, 'plan_enabled', planMessage(outcome, true), {
        outcome,
        control: this.deps.controlPayload(context.sessionId),
      })
    const promptId = this.schedulePrompt(context, message)
    return { status: 'submitted', promptId }
  }

  private executeGoal(
    context: CommandExecutionContext,
  ): CommandInvocationResult {
    const result = this.deps.runGoalCommand(
      context.sessionId,
      rawTail(context.parsed),
    )
    if (result.kind === 'error')
      return rejected('goal_command_invalid', result.text)
    return completed(context, 'goal', result.text)
  }

  private schedulePrompt(
    context: CommandExecutionContext,
    content: string,
    displayContent = context.parsed.raw,
  ): string {
    const promptId = `command_prompt_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    void this.deps
      .submitPrompt({
        sessionId: context.sessionId,
        content,
        displayContent,
        clientMessageId: promptId,
        delivery: 'queue',
        source: 'command',
        attachmentIds: context.attachments,
      })
      .catch(() => undefined)
    return promptId
  }
}

/** The text after the command token, exactly as typed. */
function rawTail(parsed: ParsedCommandInput): string {
  return parsed.raw.replace(/^\S+/, '').trim()
}

function planMessage(
  outcome: CommandPlanSwitchOutcome,
  active: boolean,
): string {
  if (outcome === 'noop')
    return active ? '已处于 Plan 模式。' : '当前未处于 Plan 模式。'
  if (outcome === 'queued')
    return active
      ? 'Plan 模式将在当前步骤结束后开启。'
      : 'Plan 模式将在当前步骤结束后关闭。'
  if (outcome === 'cancelled') return '已撤销尚未生效的 Plan 模式切换。'
  return active ? 'Plan 模式已开启。' : 'Plan 模式已关闭。'
}

function rejected(code: string, message: string): CommandInvocationResult {
  return { status: 'rejected', code, message }
}

function completed(
  context: CommandExecutionContext,
  code: string,
  message: string,
  data?: Record<string, unknown>,
): CommandInvocationResult {
  return {
    status: 'completed',
    receipt: {
      commandId: context.descriptor.id,
      code,
      message,
      ...(data ? { data } : {}),
    },
  }
}
