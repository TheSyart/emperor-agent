/**
 * 斜杠命令输出的纯文本渲染器（W6：从 App.vue 下沉）。
 * 全部为显式输入的纯函数，便于 headless 测试；不得触碰组件作用域。
 */
import { slashCommands } from '../commands'
import type { BootstrapPayload, CompactResult, ControlPayload, TokenStatsRow } from '../types'
import { formatNumber, usageTypeLabel } from '../utils/format'

export function inlineCode(value: string) {
  return '`' + value + '`'
}

export function renderCommandHelp() {
  return [
    '## 斜杠命令',
    '',
    ...slashCommands.map((command) => `- ${inlineCode(command.usage)}：${command.description}`),
    '',
    '### Skill 快捷调用',
    '',
    `- ${inlineCode('/<skill-name> 任务')}：强制本轮预加载并使用指定 Skill`,
    `- ${inlineCode('/<skill-name>-skill 任务')}：当名称与系统命令冲突时使用 Skill 别名`,
    '',
    '提示：输入 `/` 会显示候选，按 `Tab` 可补全第一项。',
  ].join('\n')
}

export interface StatusRenderInput {
  boot: BootstrapPayload | null
  busy: boolean
  runtimeText: string
  eventTransportText: string
  routeName: string
}

export function renderStatus({ boot, busy, runtimeText, eventTransportText, routeName }: StatusRenderInput) {
  const current = boot?.modelConfig?.current
  const totals = boot?.memory?.tokenTotals || {}
  const unarchived = boot?.unarchivedHistory?.length || 0
  return [
    '## 当前状态',
    '',
    `- 运行时：**${runtimeText}**`,
    `- 事件通道：${inlineCode(eventTransportText)}`,
    `- 忙碌状态：${busy ? '正在执行' : '空闲'}`,
    `- Provider：${inlineCode(current?.provider || boot?.provider || 'unknown')}`,
    `- Main Model：${inlineCode(current?.mainModelId || current?.model || boot?.model || 'unknown')}`,
    `- Secondary Model：${current?.secondaryModelId ? inlineCode(current.secondaryModelId) : '未配置'}`,
    `- Token 总量：${Number(totals.total || 0).toLocaleString('zh-CN')}`,
    `- 模型调用：${Number(totals.calls || 0).toLocaleString('zh-CN')} 次`,
    `- Skills：${boot?.skills?.length || 0}`,
    `- Tools：${boot?.tools?.length || 0}`,
    `- Control：${inlineCode(boot?.control?.mode || 'ask_before_edit')}`,
    `- 未归档消息：${unarchived}`,
    `- 当前页：${inlineCode(routeName || 'chat')}`,
  ].join('\n')
}

export function renderModeStatus(control: ControlPayload | undefined | null) {
  return [
    '## 权限模式',
    '',
    `- 当前模式：${inlineCode(control?.mode || 'ask_before_edit')}`,
    `- 进入 Plan 前模式：${control?.previous_mode ? inlineCode(control.previous_mode) : '无'}`,
    `- 等待交互：${control?.pending ? inlineCode(`${control.pending.kind}:${control.pending.id}`) : '无'}`,
  ].join('\n')
}

export function renderPlanStatus(control: ControlPayload | undefined | null) {
  const pending = control?.pending
  return [
    '## Plan 模式',
    '',
    `- 当前模式：${inlineCode(control?.mode || 'ask_before_edit')}`,
    `- 进入 Plan 前模式：${control?.previous_mode ? inlineCode(control.previous_mode) : '无'}`,
    `- 等待交互：${pending ? inlineCode(`${pending.kind}:${pending.id}`) : '无'}`,
  ].join('\n')
}

export function renderModelInfo(boot: BootstrapPayload | null) {
  const payload = boot?.modelConfig
  const current = payload?.current
  const provider = current?.provider || boot?.provider || 'unknown'
  const rawProvider = payload?.config?.providers?.[provider] || {}
  return [
    '## 模型信息',
    '',
    `- Provider：${inlineCode(provider)}`,
    `- Provider Label：${current?.providerLabel || boot?.providerLabel || 'unknown'}`,
    `- Main Model：${inlineCode(current?.mainModelId || current?.model || boot?.model || 'unknown')}`,
    `- Secondary Model：${current?.secondaryModelId ? inlineCode(current.secondaryModelId) : '未配置'}`,
    `- Secondary Enabled：${payload?.routing?.secondaryEnabled ? 'yes' : 'no'}`,
    `- API Base：${inlineCode(String(rawProvider.apiBase || current?.apiBase || '未配置'))}`,
    `- Max Tokens：${formatNumber(current?.maxTokens || 0)}`,
    `- Temperature：${current?.temperature ?? '未配置'}`,
    `- Reasoning Effort：${current?.reasoningEffort || 'null'}`,
    `- Context Window：${formatNumber(current?.contextWindowTokens || 0)}`,
    `- 可选 Provider 数：${payload?.providerOptions?.length || 0}`,
    '',
    'API Key 不在命令输出中展示。',
  ].join('\n')
}

export function renderTokenInfo(boot: BootstrapPayload | null) {
  const memory = boot?.memory || {}
  const totals = memory.tokenTotals || {}
  return [
    '## Token 消耗',
    '',
    `- 总量：${formatNumber(totals.total || 0)}`,
    `- 调用次数：${formatNumber(totals.calls || 0)}`,
    `- Input：${formatNumber(totals.input || 0)}`,
    `- Output：${formatNumber(totals.output || 0)}`,
    `- Cache Read：${formatNumber(totals.cache_read || 0)}`,
    `- Cache Create：${formatNumber(totals.cache_create || 0)}`,
    '',
    '### 按模型 / 厂家',
    renderStats(memory.tokensByModel, 'model'),
    '',
    '### 按使用种类',
    renderStats(memory.tokensByUsageType, 'usage'),
    '',
    '### 按日期',
    renderStats(memory.tokens, 'date'),
  ].join('\n')
}

export function renderToolsInfo(boot: BootstrapPayload | null) {
  const tools = boot?.tools || []
  return [
    `## Tools (${tools.length})`,
    '',
    ...tools.map((tool) => {
      const flags = [
        tool.read_only ? 'read' : 'write',
        tool.concurrency_safe ? 'parallel' : '',
        tool.exclusive ? 'exclusive' : '',
      ].filter(Boolean).join(', ')
      return `- ${inlineCode(tool.name)}：${tool.description || '无描述'} (${flags})`
    }),
  ].join('\n')
}

export function renderSkillsInfo(boot: BootstrapPayload | null) {
  const skills = boot?.skills || []
  return [
    `## Skills (${skills.length})`,
    '',
    ...skills.map((skill) => `- ${inlineCode(skill.name)}：${skill.description || skill.path}`),
  ].join('\n')
}

export function renderConfigInfo(configContent: string) {
  const content = configContent || ''
  const lines = content.split('\n').length
  return [
    '## 配置文件',
    '',
    `- 文件：${inlineCode('templates/USER.local.md')}`,
    `- 行数：${lines}`,
    `- 字符数：${formatNumber(content.length)}`,
    '',
    '可直接在「配置文件」页面查看和编辑。',
  ].join('\n')
}

export function renderMemoryInfo(boot: BootstrapPayload | null) {
  const memory = boot?.memory || {}
  return [
    '## 记忆状态',
    '',
    `- 长期记忆字符数：${formatNumber((memory.long_term || '').length)}`,
    `- 今日情景记忆字符数：${formatNumber((memory.today_episode || '').length)}`,
    `- 情景记忆文件数：${formatNumber(memory.episodes?.length || 0)}`,
    `- 未归档消息：${formatNumber(boot?.unarchivedHistory?.length || 0)}`,
    '',
    '如需立即压缩未归档会话，输入 `/compact`。',
  ].join('\n')
}

export function renderMemoryVersions(boot: BootstrapPayload | null) {
  const versions = boot?.memory?.versions?.versions || []
  if (!versions.length) {
    return '还没有记忆版本快照。保存长期记忆、情景记忆或压缩记忆后会自动生成。'
  }
  return [
    `## 记忆版本 (${boot?.memory?.versions?.count || versions.length})`,
    '',
    ...versions.slice(0, 12).map((version) => [
      `- ${inlineCode(version.id)} · ${version.target} · ${version.relPath}`,
      `  ${new Date(version.createdAt * 1000).toLocaleString('zh-CN', { hour12: false })} · ${version.reason} · ${formatNumber(version.bytes)} bytes`,
    ].join('\n')),
    '',
    `恢复：${inlineCode('/memory-restore <id>')}`,
  ].join('\n')
}

export function renderCompactResult(result: CompactResult) {
  return [
    '## 会话压缩',
    '',
    `- 状态：${result.status === 'compacted' ? '已压缩' : '跳过'}`,
    `- 处理消息数：${formatNumber(result.count)}`,
    `- 结果：${result.message}`,
    `- 剩余未归档消息：${formatNumber(result.unarchivedHistory.length)}`,
  ].join('\n')
}

export function renderStats(stats: Record<string, TokenStatsRow> | undefined, kind: 'model' | 'usage' | 'date') {
  const rows = Object.entries(stats || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0)).slice(0, 8)
  if (!rows.length) return '- 暂无记录'
  return rows
    .map(([key, row]) => `- ${kind === 'usage' ? usageTypeLabel(key) : key}：${formatNumber(row.total || 0)} tokens / ${formatNumber(row.calls || 0)} calls`)
    .join('\n')
}
