import type {
  CommandArgumentSpec,
  CommandBusyPolicy,
  CommandDescriptor,
  CommandInvocationSource,
  CommandKind,
  CommandSurface,
} from './types'

const DESKTOP: CommandInvocationSource[] = ['desktop']
const READ_SAFE: CommandInvocationSource[] = ['desktop', 'automation', 'acp']

interface BuiltinSpec {
  name: string
  aliases?: string[]
  hiddenAliases?: string[]
  category: string
  description: string
  kind?: CommandKind
  busyPolicy?: CommandBusyPolicy
  args?: CommandArgumentSpec[]
  argumentHint?: string
  sources?: CommandInvocationSource[]
  surface?: CommandSurface
  dangerous?: boolean
}

const specs: BuiltinSpec[] = [
  ui('help', '系统与诊断', '打开命令中心', 'command_center', {
    aliases: ['commands'],
    argumentHint: '[--all]',
    args: [{ name: 'all', type: 'boolean', positional: false }],
  }),
  ui('status', '系统与诊断', '查看当前会话、模型、执行与连接状态', 'status'),
  ui('doctor', '系统与诊断', '打开诊断并执行只读刷新', 'diagnostics'),
  ui('context', '系统与诊断', '查看上下文组成、占用、压缩和省略项', 'context'),
  ui('cost', '系统与诊断', '查看 Token 与成本账本', 'cost', {
    hiddenAliases: ['tokens', 'token', 'usage'],
  }),
  ui('config', '系统与诊断', '打开配置页面', 'config', {
    aliases: ['configs'],
  }),
  ui('theme', '系统与诊断', '打开外观选择器或切换主题', 'theme', {
    argumentHint: '[dark|light]',
    args: [enumArg('theme', ['dark', 'light'])],
  }),
  action(
    'reload',
    '系统与诊断',
    '刷新应用、命令、Skill、MCP 和状态投影',
    'immediate',
  ),

  action(
    'clear',
    '会话与历史',
    '创建不含当前会话历史的新上下文',
    'after_turn',
    { hiddenAliases: ['reset', 'new'], dangerous: true },
  ),
  action('compact', '会话与历史', '压缩当前会话并保留摘要', 'after_turn', {
    argumentHint: '[instructions]',
    args: [stringArg('instructions', true)],
  }),
  ui('resume', '会话与历史', '搜索并恢复历史会话', 'session_search', {
    argumentHint: '[session-id|搜索词]',
    args: [stringArg('query', true)],
  }),
  ui('rename', '会话与历史', '重命名当前会话', 'rename_session', {
    argumentHint: '[title]',
    args: [stringArg('title', true)],
  }),
  ui('export', '会话与历史', '导出当前对话', 'export_session', {
    argumentHint: '[filename]',
    args: [stringArg('filename')],
  }),
  action('copy', '会话与历史', '复制最后一条完整 Assistant 回复', 'immediate'),

  ui('model', '模型与执行', '选择或激活模型', 'model', {
    argumentHint: '[model-id]',
    args: [idArg('model-id')],
  }),
  ui('effort', '模型与执行', '查看或设置 reasoning effort', 'effort', {
    argumentHint: '[level]',
    args: [stringArg('level')],
  }),
  ui('permissions', '模型与执行', '管理三档执行权限', 'permissions', {
    hiddenAliases: ['allowed-tools', 'mode'],
    argumentHint: '[ask|smart|full]',
    args: [
      enumArg('mode', ['ask', 'smart', 'full', 'edits', 'auto', 'status']),
    ],
  }),
  action('plan', '模型与执行', '管理 Plan 或提交新的规划请求', 'after_turn', {
    argumentHint: '[on|off|status|open|description]',
    args: [stringArg('action-or-description', true)],
  }),
  action('goal', '模型与执行', '管理当前会话 Goal', 'after_turn', {
    hiddenAliases: [
      'goals',
      'goal-start',
      'goal-status',
      'goal-list',
      'goal-pause',
      'goal-resume',
      'goal-cancel',
    ],
    argumentHint: '[start|status|list|pause|resume|cancel]',
    args: [stringArg('action-or-outcome', true)],
  }),
  action('stop', '模型与执行', '立即停止当前前台执行', 'immediate', {
    sources: READ_SAFE,
  }),
  action('continue', '模型与执行', '恢复暂停的 Plan 或 Goal', 'after_turn'),

  ui('memory', '能力与工作台', '打开 Memory 或管理记忆版本', 'memory', {
    argumentHint: '[show|log|restore]',
    hiddenAliases: ['memory-log', 'memory-restore'],
    args: [stringArg('action-or-version', true)],
  }),
  ui('skills', '能力与工作台', '打开 Skills 或定位指定 Skill', 'skills', {
    argumentHint: '[name]',
    args: [idArg('name')],
  }),
  ui('tools', '能力与工作台', '打开 Tools 或定位指定工具', 'tools', {
    argumentHint: '[name]',
    args: [idArg('name')],
  }),
  ui('mcp', '能力与工作台', '打开或管理 MCP', 'mcp', {
    argumentHint: '[status|enable|disable]',
    args: [stringArg('action', true)],
  }),
  ui('hooks', '能力与工作台', '打开 Hooks 面板', 'hooks'),
  ui('agents', '能力与工作台', '查看 Agent 定义与当前子代理', 'agents'),
  ui('tasks', '能力与工作台', '查看当前会话后台任务', 'tasks'),
  ui('diff', '能力与工作台', '打开 Review 并定位文件', 'review', {
    argumentHint: '[path]',
    args: [pathArg('path')],
  }),
  ui('files', '能力与工作台', '打开当前项目文件工作区', 'files', {
    argumentHint: '[path|query]',
    args: [stringArg('path-or-query', true)],
  }),
  ui('terminal', '能力与工作台', '打开当前项目终端', 'terminal'),
  ui('review', '能力与工作台', '打开 Git Review', 'review'),
  ui('git', '能力与工作台', '打开结构化 Git 工作流', 'review', {
    argumentHint: '[status|diff|branch|commit|push|pull|compare|worktree|pr]',
    args: [stringArg('workflow', true)],
  }),
  ui('scheduler', '能力与工作台', '打开定时任务页面', 'scheduler'),
  ui('plugins', '能力与工作台', '打开插件页面', 'plugins'),
]

export function builtinCommandDescriptors(): CommandDescriptor[] {
  return specs.map((spec) => ({
    id: `builtin.${spec.name}`,
    name: spec.name,
    aliases: [...(spec.aliases ?? [])],
    hiddenAliases: [...(spec.hiddenAliases ?? [])],
    category: spec.category,
    description: spec.description,
    kind: spec.kind ?? 'local_ui',
    source: 'builtin',
    busyPolicy: spec.busyPolicy ?? 'immediate',
    argumentSchema: (spec.args ?? []).map((arg) => ({ ...arg })),
    argumentHint: spec.argumentHint,
    userInvocable: true,
    invocationSources: [...(spec.sources ?? DESKTOP)],
    available: true,
    uiSurface: spec.surface,
    dangerous: spec.dangerous,
  }))
}

function ui(
  name: string,
  category: string,
  description: string,
  surface: CommandSurface,
  extra: Partial<BuiltinSpec> = {},
): BuiltinSpec {
  return { name, category, description, surface, kind: 'local_ui', ...extra }
}

function action(
  name: string,
  category: string,
  description: string,
  busyPolicy: CommandBusyPolicy,
  extra: Partial<BuiltinSpec> = {},
): BuiltinSpec {
  return {
    name,
    category,
    description,
    kind: 'core_action',
    busyPolicy,
    ...extra,
  }
}

function stringArg(name: string, variadic = false): CommandArgumentSpec {
  return { name, type: 'string', positional: true, variadic }
}
function enumArg(name: string, values: string[]): CommandArgumentSpec {
  return { name, type: 'enum', positional: true, values }
}
function idArg(name: string): CommandArgumentSpec {
  return { name, type: 'id', positional: true }
}
function pathArg(name: string): CommandArgumentSpec {
  return { name, type: 'relative_path', positional: true }
}
