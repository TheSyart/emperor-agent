import type { ToolSegment, ToolStatus } from '../../types'

const MAX_TARGET_LENGTH = 56
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

export function isFileTool(name: string) {
  return FILE_TOOLS.has(name)
}

export function toolDisplayName(name: string) {
  const names: Record<string, string> = {
    ask_user: 'Ask',
    dispatch_subagent: 'Agent',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Search',
    load_skill: 'Skill',
    propose_plan: 'Plan',
    read_file: 'Read',
    run_command: 'Bash',
    scheduler: 'Scheduler',
    update_todos: 'Update Todos',
    web_fetch: 'Fetch',
    write_file: 'Write',
  }
  return names[name] || name
}

export function toolPurpose(name: string) {
  const purposes: Record<string, string> = {
    ask_user: '询问用户',
    dispatch_subagent: '派遣子代理',
    edit_file: '修改文件',
    glob: '匹配路径',
    grep: '搜索文本',
    load_skill: '加载 Skill',
    propose_plan: '提交计划',
    read_file: '读取文件',
    run_command: '执行命令',
    scheduler: '调度任务',
    update_todos: '更新任务',
    web_fetch: '读取网页',
    write_file: '写入文件',
  }
  return purposes[name] || '工具执行'
}

export function toolTargetLabel(tool: Pick<ToolSegment, 'name' | 'arguments' | 'metadata'>) {
  const args = tool.arguments || {}
  const metadata = tool.metadata || {}
  const target = rawToolTarget(tool.name, args, metadata)
  if (!target) return ''
  return isFileTool(tool.name) ? fileName(target) : shortenTarget(target)
}

export function toolTitle(tool: Pick<ToolSegment, 'name' | 'displayName' | 'arguments' | 'metadata'>) {
  const name = tool.displayName || toolDisplayName(tool.name)
  const target = toolTargetLabel(tool)
  return target ? `${name} · ${target}` : `${name} · ${toolPurpose(tool.name)}`
}

function rawToolTarget(name: string, args: Record<string, unknown>, metadata: Record<string, unknown>) {
  if (isFileTool(name)) {
    return firstString(metadata.path, args.path)
  }
  if (name === 'glob') {
    return firstString(args.pattern, args.path)
  }
  if (name === 'grep') {
    return firstString(args.pattern, args.query, args.path)
  }
  if (name === 'web_fetch') {
    return firstString(args.url)
  }
  if (name === 'load_skill') {
    return firstString(args.name, args.skill, args.skill_name)
  }
  if (name === 'scheduler') {
    return firstString(args.action)
  }
  if (name === 'dispatch_subagent') {
    return firstString(args.agent_type, args.task)
  }
  return ''
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function fileName(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.at(-1) || normalized
}

function shortenTarget(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (normalized.length <= MAX_TARGET_LENGTH) return normalized

  const parts = normalized.split('/').filter(Boolean)
  if (parts.length >= 4) {
    const tail = parts.slice(-4).join('/')
    if (tail.length + 4 <= MAX_TARGET_LENGTH) return `.../${tail}`
  }
  if (parts.length >= 3) {
    const tail = parts.slice(-3).join('/')
    if (tail.length + 4 <= MAX_TARGET_LENGTH) return `.../${tail}`
  }

  const head = normalized.slice(0, 24).trimEnd()
  const tail = normalized.slice(-(MAX_TARGET_LENGTH - head.length - 3)).trimStart()
  return `${head}...${tail}`
}

/** 截断输出的完整内容 ref（Wave3.1）：仅当输出被截断且后端已落盘时可回看。 */
export function fullOutputRef(tool: Pick<ToolSegment, 'outputTruncated' | 'metadata'>): string {
  if (!tool.outputTruncated) return ''
  return String(tool.metadata?.full_output_ref ?? '')
}

/** 统一的工具状态徽标文案（Wave4.2）：排队 vs 执行中明确区分。 */
export function toolStatusText(status: ToolStatus): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '执行中'
  if (status === 'done') return '完成'
  if (status === 'error_aborted') return '已中断'
  return '出错'
}

export function durationLabel(ms?: number): string {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
