// Tool view registry: wire tool name → leading icon, row title, collapsed
// summary and the expanded body kind (dsh `tool.call.toolview` keyed slot,
// as a plain table). Unknown tools fall back to the generic IN/OUT card;
// `mcp_<server>_<tool>` resolves to the MCP view and `ui_*` / `browser_*` /
// `desktop_*` to the Computer Use view.
import type { Component } from 'vue'
import {
  DsAgent,
  DsApi,
  DsBrowse,
  DsChecklist,
  DsClock,
  DsEdit,
  DsGlobe,
  DsGoal,
  DsInspect,
  DsPlan,
  DsQuestion,
  DsSearch,
  DsSkill,
  DsSparkle,
  DsSubagent,
  DsTerminal,
  DsWorkflow,
} from '../../icons/ds'
import type { ToolChatData } from '../../../conversation/types'
import {
  JOB_STATUS_LABEL,
  PLAN_OUTCOME_LABEL,
  argsOf,
  argsPreview,
  boolArg,
  firstLine,
  globCard,
  grepCard,
  mcpIdentity,
  memoryTargetLabel,
  metaOf,
  numberArg,
  planOutcome,
  planTitle,
  questionItems,
  shortPath,
  stringArg,
  todoItems,
  truncate,
  webCard,
} from './toolModel'
import {
  computerUseSummary,
  computerUseSuffix,
  computerUseSuffixTone,
  computerUseTitle,
  isComputerUseTool,
} from './computerUseModel'

/** Expanded-body renderer family (see `bodies.ts`). */
export type ToolBodyKind =
  | 'bash'
  | 'read'
  | 'diff'
  | 'glob'
  | 'grep'
  | 'web'
  | 'todo'
  | 'ask'
  | 'plan'
  | 'subagent'
  | 'job'
  | 'mcp'
  | 'scheduler'
  | 'skill'
  | 'workflow'
  | 'computer'
  | 'generic'

export interface ToolViewSpec {
  readonly icon: Component
  /** Row title (short, 14/24 secondary). */
  title(data: ToolChatData): string
  /** Collapsed summary after the dot ('' drops the separator). */
  summary(data: ToolChatData): string
  /** Non-shrinking summary tail (dsh summarySuffix), e.g. `+2`. */
  suffix?(data: ToolChatData): string | null
  /** Emphasis of the tail: 'warn' for results the user must notice. */
  suffixTone?(data: ToolChatData): 'warn' | 'accent' | null
  readonly body: ToolBodyKind
  /** Summary is a file path (rendered as a path link). */
  readonly pathSummary?: boolean
}

const join = (...parts: (string | undefined | null | false)[]): string =>
  parts.filter((part): part is string => Boolean(part)).join(' · ')

function pathArg(data: ToolChatData): string {
  const meta = metaOf(data)
  const path =
    (typeof meta?.path === 'string' ? meta.path : undefined) ??
    stringArg(argsOf(data), 'file_path') ??
    ''
  return shortPath(path)
}

const bash: ToolViewSpec = {
  icon: DsTerminal,
  body: 'bash',
  title: () => '终端',
  summary: (data) => {
    const args = argsOf(data)
    const description = stringArg(args, 'description')
    const command = stringArg(args, 'command') ?? ''
    const head =
      description !== undefined && description.trim() !== ''
        ? description.trim()
        : truncate(firstLine(command))
    if (boolArg(args, 'run_in_background') !== true) return head
    const job = data.job
    return join(
      head,
      job === undefined
        ? '后台'
        : `后台 ${JOB_STATUS_LABEL[job.status] ?? job.status}`,
    )
  },
}

const read: ToolViewSpec = {
  icon: DsBrowse,
  body: 'read',
  pathSummary: true,
  title: () => '读取',
  summary: (data) => {
    const meta = metaOf(data)
    const args = argsOf(data)
    const start =
      typeof meta?.startLine === 'number'
        ? meta.startLine
        : numberArg(args, 'offset')
    const end =
      typeof meta?.endLine === 'number'
        ? meta.endLine
        : start !== undefined && numberArg(args, 'limit') !== undefined
          ? start + (numberArg(args, 'limit') ?? 0) - 1
          : undefined
    const total =
      typeof meta?.totalLines === 'number' ? meta.totalLines : undefined
    const windowed =
      start !== undefined &&
      end !== undefined &&
      !(start <= 1 && total !== undefined && end >= total)
    return join(pathArg(data), windowed && `第 ${start}–${end} 行`)
  },
}

const write: ToolViewSpec = {
  icon: DsEdit,
  body: 'diff',
  pathSummary: true,
  title: (data) => (metaOf(data)?.operation === 'create' ? '新建' : '写入'),
  summary: pathArg,
}

const edit: ToolViewSpec = {
  icon: DsEdit,
  body: 'diff',
  pathSummary: true,
  title: () => '编辑',
  summary: pathArg,
}

const memoryEdit: ToolViewSpec = {
  icon: DsEdit,
  body: 'diff',
  title: () => '记忆',
  summary: (data) => {
    const args = argsOf(data)
    return join(
      memoryTargetLabel(stringArg(args, 'target')),
      stringArg(args, 'old_string') === undefined ? '追加' : '替换',
    )
  },
}

const glob: ToolViewSpec = {
  icon: DsSearch,
  body: 'glob',
  title: () => '查找文件',
  summary: (data) => {
    const args = argsOf(data)
    const card = globCard(data)
    return join(
      stringArg(args, 'pattern'),
      stringArg(args, 'path') !== undefined &&
        `于 ${shortPath(stringArg(args, 'path') ?? '')}`,
      card !== null && `${card.total} 个路径`,
    )
  },
}

const grep: ToolViewSpec = {
  icon: DsSearch,
  body: 'grep',
  title: () => '搜索',
  summary: (data) => {
    const args = argsOf(data)
    const card = grepCard(data)
    const count =
      card === null
        ? undefined
        : (card.total ??
          card.files.reduce((sum, file) => sum + file.matches.length, 0))
    return join(
      stringArg(args, 'pattern'),
      stringArg(args, 'include'),
      stringArg(args, 'path') !== undefined &&
        `于 ${shortPath(stringArg(args, 'path') ?? '')}`,
      count !== undefined && `${count} 处匹配`,
    )
  },
}

const webSearch: ToolViewSpec = {
  icon: DsGlobe,
  body: 'web',
  title: () => '网页搜索',
  summary: (data) => {
    const queries = argsOf(data).queries
    const list = Array.isArray(queries)
      ? queries.filter((q): q is string => typeof q === 'string')
      : []
    const card = webCard(data)
    return join(
      list.join('、'),
      card !== null && `${card.sources.length} 个来源`,
    )
  },
}

const todoWrite: ToolViewSpec = {
  icon: DsChecklist,
  body: 'todo',
  title: () => '任务清单',
  summary: (data) => {
    const items = todoItems(data)
    if (items === null) return ''
    const done = items.filter((item) => item.status === 'completed').length
    const active = items.filter((item) => item.status === 'in_progress')
    return join(`已完成 ${done}/${items.length}`, active[0]?.content)
  },
  suffix: (data) => {
    const active =
      todoItems(data)?.filter((item) => item.status === 'in_progress') ?? []
    return active.length > 1 ? `+${active.length - 1}` : null
  },
}

const askUserQuestion: ToolViewSpec = {
  icon: DsQuestion,
  body: 'ask',
  title: () => '提问',
  summary: (data) => {
    const items = questionItems(data)
    const first = items[0]?.question
    const outcome = data.question?.outcome
    if (data.status === 'interrupted') return join('已中断', first)
    if (outcome === 'cancelled') return join('已取消', first)
    if (outcome === 'unavailable') return join('无法提问', first)
    if (outcome === 'answered') {
      const answered = items.filter(
        (item) => item.selected.length > 0 || item.custom !== undefined,
      ).length
      return join(`已回答 ${answered}/${items.length}`, first)
    }
    if (data.status === 'running') return join('等待回答', first)
    return first ?? ''
  },
}

const exitPlanMode: ToolViewSpec = {
  icon: DsPlan,
  body: 'plan',
  title: () => '计划',
  summary: (data) => {
    const plan = stringArg(argsOf(data), 'plan') ?? ''
    return join(planTitle(plan), PLAN_OUTCOME_LABEL[planOutcome(data).outcome])
  },
}

const SUBAGENT_STOP_LABEL: Record<string, string> = {
  completed: '已完成',
  aborted: '已中止',
  error: '失败',
  'max-tokens': '输出超限',
  refusal: '已拒绝',
  interrupted: '已中断',
}

export function subagentStatusLabel(data: ToolChatData): string {
  const sub = data.subagent
  if (sub === undefined)
    return data.status === 'running'
      ? '启动中'
      : data.status === 'interrupted'
        ? '已中断'
        : ''
  if (sub.status === 'running') return sub.background ? '后台运行中' : '运行中'
  return SUBAGENT_STOP_LABEL[sub.stopReason ?? 'completed'] ?? '已结束'
}

function subagentSpec(fork: boolean): ToolViewSpec {
  return {
    icon: DsSubagent,
    body: 'subagent',
    title: () => (fork ? '分叉子代理' : '子代理'),
    summary: (data) =>
      join(
        data.subagent?.description ?? stringArg(argsOf(data), 'description'),
        subagentStatusLabel(data),
      ),
  }
}

const agentMessage = (title: string, key: string): ToolViewSpec => ({
  icon: DsAgent,
  body: 'generic',
  title: () => title,
  summary: (data) => truncate(stringArg(argsOf(data), key) ?? ''),
})

const jobSpec = (title: string): ToolViewSpec => ({
  icon: DsClock,
  body: 'job',
  title: () => title,
  summary: (data) => {
    const args = argsOf(data)
    const job = metaOf(data)?.job as { status?: string } | undefined
    return join(
      stringArg(args, 'job_id'),
      boolArg(args, 'wait') === true && '等待结束',
      job?.status !== undefined && (JOB_STATUS_LABEL[job.status] ?? job.status),
    )
  },
})

const jobList: ToolViewSpec = {
  icon: DsClock,
  body: 'job',
  title: () => '后台任务',
  summary: (data) => {
    const jobs = metaOf(data)?.jobs
    return Array.isArray(jobs) ? `${jobs.length} 个任务` : ''
  },
}

const workflowSpec: ToolViewSpec = {
  icon: DsWorkflow,
  body: 'workflow',
  title: () => '工作流',
  summary: (data) => {
    const meta = argsOf(data).meta as
      { name?: unknown; description?: unknown } | undefined
    const name =
      data.workflow?.name ??
      (typeof meta?.name === 'string' ? meta.name : undefined)
    const description =
      data.workflow?.description ??
      (typeof meta?.description === 'string' ? meta.description : undefined)
    return join(name, description !== name && description)
  },
}

const ralphSpec: ToolViewSpec = {
  icon: DsWorkflow,
  body: 'workflow',
  title: () => 'Ralph 循环',
  summary: (data) => {
    const args = argsOf(data)
    const rounds = numberArg(args, 'maxRounds')
    return join(
      truncate(stringArg(args, 'objective') ?? ''),
      rounds !== undefined && `最多 ${rounds} 轮`,
    )
  },
}

const SCHEDULER_ACTION_LABEL: Record<string, string> = {
  add: '新建',
  list: '列出',
  update: '更新',
  remove: '删除',
  pause: '暂停',
  resume: '恢复',
  run: '立即运行',
}

const scheduler: ToolViewSpec = {
  icon: DsClock,
  body: 'scheduler',
  title: () => '定时任务',
  summary: (data) => {
    const args = argsOf(data)
    const action = stringArg(args, 'action') ?? ''
    return join(
      SCHEDULER_ACTION_LABEL[action] ?? action,
      stringArg(args, 'name') ?? stringArg(args, 'job_id'),
    )
  },
}

const MCP_CONFIG_ACTION_LABEL: Record<string, string> = {
  list: '列出',
  add: '添加',
  remove: '删除',
  enable: '启用',
  disable: '停用',
  reload: '重载',
}

/** Builtin `mcp_config` (Emperor's MCP config), not an `mcp_<server>_<tool>` call. */
const mcpConfig: ToolViewSpec = {
  icon: DsApi,
  body: 'generic',
  title: () => 'MCP 配置',
  summary: (data) => {
    const args = argsOf(data)
    const action = stringArg(args, 'action') ?? ''
    return join(
      MCP_CONFIG_ACTION_LABEL[action] ?? action,
      stringArg(args, 'name'),
    )
  },
}

const skill: ToolViewSpec = {
  icon: DsSkill,
  body: 'skill',
  title: () => '技能',
  summary: (data) => stringArg(argsOf(data), 'name') ?? '',
}

const goalSpec = (title: string): ToolViewSpec => ({
  icon: DsGoal,
  body: 'generic',
  title: () => title,
  summary: (data) => argsPreview(argsOf(data)),
})

const mcp: ToolViewSpec = {
  icon: DsApi,
  body: 'mcp',
  title: (data) => mcpIdentity(data)?.tool ?? data.name,
  summary: (data) => {
    const meta = metaOf(data)
    const summary =
      typeof meta?.summary === 'string' && meta.summary !== ''
        ? truncate(meta.summary)
        : argsPreview(argsOf(data))
    return join(mcpIdentity(data)?.server, summary)
  },
}

const computerUse = (icon: Component): ToolViewSpec => ({
  icon,
  body: 'computer',
  title: (data) => computerUseTitle(data.name),
  summary: computerUseSummary,
  suffix: computerUseSuffix,
  suffixTone: computerUseSuffixTone,
})
const browserTool = computerUse(DsBrowse)
const uiTool = computerUse(DsInspect)

const generic: ToolViewSpec = {
  icon: DsSparkle,
  body: 'generic',
  title: (data) => data.name,
  summary: (data) => argsPreview(argsOf(data)),
}

const REGISTRY: Readonly<Record<string, ToolViewSpec>> = {
  bash,
  read,
  write,
  edit,
  memory_edit: memoryEdit,
  glob,
  grep,
  web_search: webSearch,
  todo_write: todoWrite,
  ask_user_question: askUserQuestion,
  exit_plan_mode: exitPlanMode,
  subagent: subagentSpec(false),
  subagent_fork: subagentSpec(true),
  send_message: agentMessage('发送消息', 'message'),
  interrupt_agent: agentMessage('中断代理', 'agent_id'),
  list_agents: agentMessage('列出代理', 'scope'),
  report: agentMessage('汇报', 'output'),
  job_output: jobSpec('任务输出'),
  job_kill: jobSpec('停止任务'),
  job_list: jobList,
  workflow: workflowSpec,
  ralph: ralphSpec,
  scheduler,
  mcp_config: mcpConfig,
  skill,
  get_goal: goalSpec('读取目标'),
  update_goal: goalSpec('更新目标'),
  structured_output: { ...generic, title: () => '结构化输出' },
}

/** Registered tool names (excluding the `mcp_*` family). */
export const REGISTERED_TOOLS: readonly string[] = Object.keys(REGISTRY)

/** Resolve one wire tool name. */
export function toolView(name: string): ToolViewSpec {
  return (
    REGISTRY[name] ??
    (name.startsWith('mcp_') ? mcp : undefined) ??
    (isComputerUseTool(name)
      ? name.startsWith('ui_')
        ? uiTool
        : browserTool
      : undefined) ??
    generic
  )
}
