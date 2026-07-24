import type { ToolSegment } from '../../types'
import { toolTitle } from './toolDisplay'

export function toolCardDefaultOpen(tools: ToolSegment[]) {
  return tools.some(
    (tool) => tool.status === 'error' || tool.status === 'error_aborted',
  )
}

const FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'rename_file',
  'move_file',
  'apply_patch',
])

export function toolBatchTitle(tools: ToolSegment[]) {
  if (!tools.length) return '工具调用'
  if (tools.every(isIndependentReviewer)) return '独立复核'
  if (tools.every((tool) => FILE_MUTATION_TOOLS.has(tool.name))) {
    return `修改 ${tools.length} 个文件`
  }

  const labels = Array.from(
    new Set(tools.map((tool) => toolBatchAction(tool.name))),
  )
  if (labels.length === 1 && tools.length > 1)
    return `${labels[0]} · ${tools.length} 项`
  if (labels.length <= 3) return labels.join('、')
  return `${labels.slice(0, 2).join('、')}等 · ${tools.length} 项`
}

function toolBatchAction(name: string) {
  if (name === 'read_file') return '读取文件'
  if (['glob', 'grep', 'search', 'code_intelligence'].includes(name))
    return '搜索代码'
  if (name === 'run_command') return '运行命令'
  if (name === 'dispatch_subagent') return '派遣子代理'
  if (name === 'update_todos') return '更新任务'
  if (FILE_MUTATION_TOOLS.has(name)) return '修改文件'
  return toolTitle({ name } as ToolSegment).split(' · ')[0] || name
}

export function toolGroupDetailText(tools: ToolSegment[]) {
  if (tools.length === 1 && isIndependentReviewer(tools[0]!)) {
    const reviewer = tools[0]!
    if (reviewer.status === 'running' || reviewer.status === 'queued')
      return '正在复核计划与验证证据'
    if (reviewer.status === 'error' || reviewer.status === 'error_aborted')
      return '复核未完成'
    return reviewerPassed(reviewer) ? '复核通过' : '复核未通过'
  }
  const runningTools = tools.filter((tool) => tool.status === 'running')
  const queuedTools = tools.filter((tool) => tool.status === 'queued')
  if (runningTools.length) {
    const queuedSuffix = queuedTools.length
      ? `（另有 ${queuedTools.length} 个排队中）`
      : ''
    return `正在执行 ${toolNames(runningTools)}${queuedSuffix}`
  }
  if (queuedTools.length) return `排队等待 ${toolNames(queuedTools)}`

  const errorTools = tools.filter(
    (tool) => tool.status === 'error' || tool.status === 'error_aborted',
  )
  if (errorTools.length) return `${errorTools.length} 个工具需要处理`

  const latestTodos = latestToolTodos(tools)
  if (
    tools.every((tool) => tool.name === 'update_todos') &&
    latestTodos.length
  ) {
    return `已更新 ${latestTodos.length} 个任务步骤`
  }
  if (latestTodos.length) return `已同步 ${latestTodos.length} 个任务步骤`

  const singlePlainDoneTool =
    tools.length === 1 &&
    tools[0]?.status === 'done' &&
    !tools[0]?.subagents?.length
  if (singlePlainDoneTool) return ''

  const completedCount = tools.filter((tool) => tool.status === 'done').length
  return `已完成 ${completedCount}/${tools.length} 个工具`
}

function isIndependentReviewer(tool: ToolSegment): boolean {
  return (
    tool.name === 'dispatch_subagent' &&
    String(tool.arguments?.agent_type ?? '') === 'verification_reviewer'
  )
}

function reviewerPassed(tool: ToolSegment): boolean {
  const output = String(tool.output ?? tool.summary ?? '')
  return /"passed"\s*:\s*true/i.test(output)
}

function latestToolTodos(tools: ToolSegment[]) {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]
    if (tool?.todos?.length) return tool.todos
  }
  return []
}

function toolNames(tools: ToolSegment[]) {
  return tools
    .map((tool) => toolTitle(tool))
    .slice(0, 2)
    .join('、')
}
