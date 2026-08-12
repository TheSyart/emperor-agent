import { randomUUID } from 'node:crypto'
import type { CommandExecutionContext } from '../../commands/platform'
import type {
  CommandCompletion,
  CommandInvocationResult,
} from '../../commands/types'
import type { GoalService } from './goal-service'
import type { CoreMemoryService } from './memory-service'
import type { CoreModelService } from './model-service'
import type { SkillInfoPayload } from './skill-service'
import type { SessionTransitionService } from '../../commands/session-transition'

interface CommandSessionEntry {
  id: string
}

interface CommandTask {
  id: string
  kind: string
}

interface CommandControlPayload {
  mode: string
  previous_mode: string | null
}

export interface CommandApplicationServiceDeps {
  models: CoreModelService
  memory: CoreMemoryService
  goals: GoalService
  sessionTransitions: SessionTransitionService
  getSession(sessionId: string): CommandSessionEntry | null
  skillsForSession(sessionId: string): SkillInfoPayload[]
  sessionBusy(sessionId: string): boolean
  listTasks(sessionId: string): CommandTask[]
  cancelTask(taskId: string): void
  cancelSessionRuntime(sessionId: string): boolean
  activateModel(entryId: string): Promise<unknown>
  setReasoningEffort(entryId: string, effort: string): Promise<unknown>
  setPermissionMode(sessionId: string, mode: string): void
  controlPayload(sessionId: string): CommandControlPayload
  setControlMode(sessionId: string, mode: string): Promise<unknown>
  defaultSubagentName(requested: string | null): string | null
  subagentToolNames(name: string): string[] | null
  submitPrompt(input: {
    sessionId: string
    content: string
    displayContent: string
    clientMessageId: string
    turnId: string
    delivery: 'queue'
    source: 'command'
    requestedSkills: Array<{ name: string; source: 'slash' }>
    attachments: string[]
  }): Promise<unknown>
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
      const result = await this.deps.memory.compact({
        force: true,
        sessionId,
        instructions: tail,
      })
      return completed(context, 'compacted', '当前会话已压缩并保留摘要。', {
        result: result as unknown as Record<string, unknown>,
      })
    }
    if (name === 'stop') {
      const tasks = this.deps.listTasks(sessionId)
      for (const task of tasks) {
        if (task.kind === 'goal')
          await this.deps.goals.pause(
            task.id.replace(/^goal:/, ''),
            sessionId,
            'user_stop',
          )
        this.deps.cancelTask(task.id)
      }
      const cancelled =
        tasks.length > 0 || this.deps.cancelSessionRuntime(sessionId)
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
      if (!model)
        return {
          status: 'rejected',
          code: 'model_not_found',
          message: `找不到模型：${tail}`,
        }
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
        return {
          status: 'rejected',
          code: 'model_unavailable',
          message: '当前没有可用模型。',
        }
      await this.deps.setReasoningEffort(config.current.entryId, tail)
      return completed(
        context,
        'reasoning_updated',
        `思考强度已切换为 ${tail}。`,
      )
    }
    if (name === 'permissions' && tail) {
      if (tail === 'status')
        return {
          status: 'opened',
          surface: 'permissions',
          params: {
            rawArgs: '',
            invokedName: parsed.name,
            commandId: descriptor.id,
          },
        }
      const mode =
        tail === 'ask'
          ? 'ask_before_edit'
          : tail === 'smart' || tail === 'edits'
            ? 'smart_auto'
            : tail === 'full' || tail === 'auto'
              ? 'full_access'
              : null
      if (!mode)
        return {
          status: 'rejected',
          code: 'invalid_permission_mode',
          message: '权限模式必须是 ask、smart 或 full。',
        }
      this.deps.setPermissionMode(sessionId, mode)
      return completed(context, 'permission_mode_updated', '执行权限已更新。', {
        mode,
      })
    }
    if (name === 'plan') return await this.executePlan(context)
    if (name === 'goal') return await this.executeGoal(context)
    if (name === 'continue') {
      const promptId = this.schedulePrompt(context, '继续执行')
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

  async submitSkill(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const binding = context.descriptor.skill
    if (!binding)
      return {
        status: 'rejected',
        code: 'skill_binding_missing',
        message: 'Skill 命令绑定缺失。',
      }
    const task = context.parsed.args.join(' ').trim()
    let forkAgent = binding.agent
    if (binding.context === 'fork') {
      forkAgent = this.deps.defaultSubagentName(forkAgent)
      const toolNames = forkAgent
        ? this.deps.subagentToolNames(forkAgent)
        : null
      if (!forkAgent || !toolNames)
        return {
          status: 'rejected',
          code: 'skill_fork_agent_unavailable',
          message: 'Skill 指定的子代理不可用。',
        }
      const unsupportedTools = binding.allowedTools.filter(
        (tool) => !toolNames.includes(tool),
      )
      if (unsupportedTools.length)
        return {
          status: 'rejected',
          code: 'skill_fork_tool_scope_invalid',
          message: `Skill 请求了子代理未获授权的工具：${unsupportedTools.join('、')}`,
        }
    }
    const content =
      binding.context === 'fork'
        ? `[CONTROL:SKILL_FORK]\nAgent: ${forkAgent}\nAllowed tools: ${binding.allowedTools.join(', ') || 'agent definition'}\nEffort: ${binding.effort || 'inherit'}\nTask: ${task || '按 Skill 默认流程执行'}`
        : task || '按 Skill 默认流程执行'
    const promptId = this.schedulePrompt(
      context,
      content,
      context.parsed.raw,
      binding.name,
    )
    return { status: 'submitted', promptId }
  }

  private async executePlan(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const tail = context.parsed.args.join(' ').trim()
    const normalized = tail.toLowerCase()
    if (!tail || normalized === 'status' || normalized === 'open')
      return {
        status: 'opened',
        surface: 'plan',
        params: { action: normalized || 'open' },
      }
    if (normalized === 'on') {
      await this.deps.setControlMode(context.sessionId, 'plan')
      return completed(context, 'plan_enabled', 'Plan 模式已开启。')
    }
    if (normalized === 'off') {
      const control = this.deps.controlPayload(context.sessionId)
      const restore =
        control.mode === 'plan' && control.previous_mode
          ? control.previous_mode
          : 'smart_auto'
      await this.deps.setControlMode(context.sessionId, restore)
      return completed(context, 'plan_disabled', 'Plan 模式已关闭。')
    }
    await this.deps.setControlMode(context.sessionId, 'plan')
    const promptId = this.schedulePrompt(context, tail, context.parsed.raw)
    return { status: 'submitted', promptId }
  }

  private async executeGoal(
    context: CommandExecutionContext,
  ): Promise<CommandInvocationResult> {
    const tail = context.parsed.args.join(' ').trim()
    if (!tail || tail === 'status' || tail === 'list')
      return {
        status: 'opened',
        surface: 'goal',
        params: { action: tail || 'open' },
      }
    const goals = await this.deps.goals.list({ sessionId: context.sessionId })
    const active = goals.find(
      (goal) => goal.status !== 'completed' && goal.status !== 'cancelled',
    )
    if (tail === 'pause' || tail === 'resume' || tail === 'cancel') {
      if (!active)
        return {
          status: 'rejected',
          code: 'goal_not_found',
          message: '当前会话没有可操作的 Goal。',
        }
      if (tail === 'pause')
        await this.deps.goals.pause(active.id, context.sessionId)
      else if (tail === 'resume')
        await this.deps.goals.resume(active.id, context.sessionId)
      else
        await this.deps.goals.cancel(
          active.id,
          'slash_command',
          context.sessionId,
        )
      return completed(
        context,
        `goal_${tail}`,
        `Goal 已${tail === 'pause' ? '暂停' : tail === 'resume' ? '恢复' : '取消'}。`,
      )
    }
    const outcome = tail.replace(/^start\s+/i, '').trim()
    if (!outcome)
      return { status: 'opened', surface: 'goal', params: { action: 'start' } }
    await this.deps.goals.start({ outcome, sessionId: context.sessionId })
    return completed(context, 'goal_started', 'Goal 已启动。')
  }

  private schedulePrompt(
    context: CommandExecutionContext,
    content: string,
    displayContent = context.parsed.raw,
    skillName?: string,
  ): string {
    const promptId = `command_prompt_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    void this.deps
      .submitPrompt({
        sessionId: context.sessionId,
        content,
        displayContent,
        clientMessageId: promptId,
        turnId: promptId,
        delivery: 'queue',
        source: 'command',
        requestedSkills: skillName
          ? [{ name: skillName, source: 'slash' }]
          : [],
        attachments: context.attachments,
      })
      .catch(() => undefined)
    return promptId
  }
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
