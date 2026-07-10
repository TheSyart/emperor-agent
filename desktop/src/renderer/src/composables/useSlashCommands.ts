/**
 * 斜杠命令解释器（W6：从 App.vue 下沉）。
 * 文本渲染在 runtime/statusRender.ts（纯函数）；这里只做命令分发与副作用编排。
 */
import type { Ref } from 'vue'
import {
  parseSkillSlashCommand,
  parseSlashCommand,
  type SlashCommand,
} from '../commands'
import { core } from '../api/http'
import type {
  BootstrapPayload,
  ChatSendPayload,
  CompactResult,
  PendingState,
} from '../types'
import {
  inlineCode,
  renderCommandHelp,
  renderCompactResult,
  renderConfigInfo,
  renderMemoryInfo,
  renderMemoryVersions,
  renderModeStatus,
  renderModelInfo,
  renderPlanStatus,
  renderSkillsInfo,
  renderStatus,
  renderTokenInfo,
  renderToolsInfo,
} from '../runtime/statusRender'

export interface SlashCommandDeps {
  boot: Ref<BootstrapPayload | null>
  configContent: Ref<string>
  busy: Ref<boolean>
  pending: PendingState
  routeName: () => string
  runtimeText: () => string
  eventTransportText: () => string
  sendMessage: (payload: string | ChatSendPayload) => boolean
  addLocalCommand: (command: string, content: string) => void
  clearChat: () => void
  stopActive: () => Promise<boolean>
  compactMemory: () => Promise<CompactResult>
  restoreMemoryVersion: (id: string) => Promise<{ restored: { path: string } }>
  refreshAll: () => Promise<void>
  showToast: (message: string) => void
}

export function useSlashCommands(deps: SlashCommandDeps) {
  const { boot, busy, pending } = deps

  function submitFromComposer(payload: string | ChatSendPayload) {
    const obj =
      typeof payload === 'string'
        ? { content: payload, attachments: [] }
        : {
            content: payload.content,
            attachments: payload.attachments || [],
            requestedSkills: payload.requestedSkills || [],
            displayContent: payload.displayContent,
          }
    const parsed = parseSlashCommand(obj.content)
    if (!obj.attachments.length && parsed?.command) {
      void executeSlashCommand(parsed.raw, parsed.name, parsed.command)
      return
    }
    const skillRequest = parseSkillSlashCommand(
      obj.content,
      boot.value?.skills || [],
    )
    if (skillRequest) {
      if (!skillRequest.task && !obj.attachments.length) {
        deps.addLocalCommand(
          skillRequest.raw,
          `请在 ${inlineCode(`/${skillRequest.name}`)} 后面补上要办的事，例如：${inlineCode(`/${skillRequest.name} 帮我设计一个设置页`)}`,
        )
        return
      }
      const outgoing: ChatSendPayload = {
        content: skillRequest.task,
        attachments: obj.attachments,
        requestedSkills: [skillRequest.requestedSkill],
        displayContent: skillRequest.raw,
      }
      deps.sendMessage(outgoing)
      return
    }
    if (!obj.attachments.length && parsed) {
      void executeSlashCommand(parsed.raw, parsed.name, parsed.command)
      return
    }
    deps.sendMessage(obj)
  }

  async function executeSlashCommand(
    raw: string,
    name: string,
    command: SlashCommand | undefined,
  ) {
    busy.value = true
    try {
      if (!command) {
        deps.addLocalCommand(
          raw,
          `未知命令：${inlineCode(name)}\n\n输入 ${inlineCode('/help')} 查看可用命令。`,
        )
        return
      }
      if (command.name === '/help')
        return deps.addLocalCommand(raw, renderCommandHelp())
      if (command.name === '/status') {
        return deps.addLocalCommand(
          raw,
          renderStatus({
            boot: boot.value,
            busy: busy.value,
            runtimeText: deps.runtimeText(),
            eventTransportText: deps.eventTransportText(),
            routeName: deps.routeName(),
          }),
        )
      }
      if (command.name === '/model')
        return deps.addLocalCommand(raw, renderModelInfo(boot.value))
      if (command.name === '/tokens')
        return deps.addLocalCommand(raw, renderTokenInfo(boot.value))
      if (command.name === '/tools')
        return deps.addLocalCommand(raw, renderToolsInfo(boot.value))
      if (command.name === '/skills')
        return deps.addLocalCommand(raw, renderSkillsInfo(boot.value))
      if (command.name === '/config')
        return deps.addLocalCommand(
          raw,
          renderConfigInfo(deps.configContent.value),
        )
      if (command.name === '/memory')
        return deps.addLocalCommand(raw, renderMemoryInfo(boot.value))
      if (command.name === '/memory-log')
        return deps.addLocalCommand(raw, renderMemoryVersions(boot.value))
      if (command.name === '/memory-restore')
        return await handleMemoryRestoreCommand(raw)
      if (command.name === '/plan') return await handlePlanCommand(raw)
      if (command.name === '/mode') return await handleModeCommand(raw)
      if (command.name === '/stop') {
        const stopped = await deps.stopActive()
        return deps.addLocalCommand(
          raw,
          stopped ? '已请求停止当前运行任务。' : '当前没有正在运行的任务。',
        )
      }
      if (command.name === '/compact') {
        pending.label = '正在压缩未归档会话...'
        pending.detail = ''
        try {
          const result = await deps.compactMemory()
          deps.addLocalCommand(raw, renderCompactResult(result))
        } catch (err) {
          deps.addLocalCommand(
            raw,
            `压缩失败：${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return
      }
      if (command.name === '/clear') return deps.clearChat()
      if (command.name === '/reload') {
        await deps.refreshAll()
        return deps.addLocalCommand(raw, '工作台状态已刷新。')
      }
    } finally {
      busy.value = false
      pending.label = ''
      pending.detail = ''
    }
  }

  async function handlePlanCommand(raw: string) {
    const [, arg = 'status'] = raw.trim().split(/\s+/, 2)
    const normalized = arg.toLowerCase()
    if (normalized === 'on' || normalized === 'plan') {
      const result = await setControlMode('plan')
      deps.addLocalCommand(
        raw,
        result.ok
          ? 'Plan 模式已开启：只读探索、提问、计划预览；批准前不会执行写操作。'
          : `Plan 模式开启失败：${result.error}`,
      )
      return
    }
    if (normalized === 'off' || normalized === 'normal') {
      const result = await setControlMode('ask_before_edit')
      deps.addLocalCommand(
        raw,
        result.ok
          ? 'Plan 模式已关闭，已回到编辑前询问模式。'
          : `Plan 模式关闭失败：${result.error}`,
      )
      return
    }
    deps.addLocalCommand(raw, renderPlanStatus(boot.value?.control))
  }

  async function handleModeCommand(raw: string) {
    const [, arg = 'status'] = raw.trim().split(/\s+/, 2)
    const normalized = arg.toLowerCase()
    if (['ask', 'ask_before_edit', 'edit_before_ask'].includes(normalized)) {
      const result = await setControlMode('ask_before_edit')
      deps.addLocalCommand(
        raw,
        result.ok
          ? '权限模式已切换为：编辑前询问。'
          : `权限模式切换失败：${result.error}`,
      )
      return
    }
    if (['accept_edits', 'accept-edits', 'edits'].includes(normalized)) {
      const result = await setControlMode('accept_edits')
      deps.addLocalCommand(
        raw,
        result.ok
          ? '权限模式已切换为：接受编辑。'
          : `权限模式切换失败：${result.error}`,
      )
      return
    }
    if (normalized === 'auto') {
      const result = await setControlMode('auto')
      deps.addLocalCommand(
        raw,
        result.ok
          ? '权限模式已切换为：自动执行。'
          : `权限模式切换失败：${result.error}`,
      )
      return
    }
    if (normalized === 'plan') {
      const result = await setControlMode('plan')
      deps.addLocalCommand(
        raw,
        result.ok
          ? '权限模式已切换为：计划模式。'
          : `权限模式切换失败：${result.error}`,
      )
      return
    }
    deps.addLocalCommand(raw, renderModeStatus(boot.value?.control))
  }

  async function setControlMode(
    mode: 'ask_before_edit' | 'accept_edits' | 'auto' | 'plan',
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const data = await core('control.setMode', mode)
      if (boot.value) boot.value.control = data
      const label =
        mode === 'plan'
          ? '计划模式'
          : mode === 'auto'
            ? '自动执行'
            : mode === 'accept_edits'
              ? '接受编辑'
              : '编辑前询问'
      deps.showToast(`已切换为${label}`)
      return { ok: true }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      deps.showToast(error)
      return { ok: false, error }
    }
  }

  async function handleMemoryRestoreCommand(raw: string) {
    const [, id = ''] = raw.trim().split(/\s+/, 2)
    if (!id) {
      deps.addLocalCommand(
        raw,
        `请提供版本 id，例如：${inlineCode('/memory-restore memv_...')}`,
      )
      return
    }
    try {
      const result = await deps.restoreMemoryVersion(id)
      deps.addLocalCommand(raw, `已恢复：${inlineCode(result.restored.path)}`)
    } catch (err) {
      deps.addLocalCommand(
        raw,
        `恢复失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { submitFromComposer, executeSlashCommand, setControlMode }
}
