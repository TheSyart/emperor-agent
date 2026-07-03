import type { ToolSegment } from '../../types'
import { toolTitle } from './toolDisplay'

export function toolGroupDetailText(tools: ToolSegment[]) {
  const runningTools = tools.filter((tool) => tool.status === 'running')
  const queuedTools = tools.filter((tool) => tool.status === 'queued')
  if (runningTools.length) {
    const queuedSuffix = queuedTools.length ? `（另有 ${queuedTools.length} 个排队中）` : ''
    return `正在执行 ${toolNames(runningTools)}${queuedSuffix}`
  }
  if (queuedTools.length) return `排队等待 ${toolNames(queuedTools)}`

  const errorTools = tools.filter((tool) => tool.status === 'error' || tool.status === 'error_aborted')
  if (errorTools.length) return `${errorTools.length} 个工具需要处理`

  const latestTodos = latestToolTodos(tools)
  if (tools.every((tool) => tool.name === 'update_todos') && latestTodos.length) {
    return `已更新 ${latestTodos.length} 个任务步骤`
  }
  if (latestTodos.length) return `已同步 ${latestTodos.length} 个任务步骤`

  const singlePlainDoneTool = tools.length === 1 &&
    tools[0]?.status === 'done' &&
    !tools[0]?.subagents?.length
  if (singlePlainDoneTool) return ''

  const completedCount = tools.filter((tool) => tool.status === 'done').length
  return `已完成 ${completedCount}/${tools.length} 个工具`
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
