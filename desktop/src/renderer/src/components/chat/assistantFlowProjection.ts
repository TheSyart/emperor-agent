import type {
  AskSegment,
  AssistantMessage,
  AssistantSegment,
  PlanSegment,
  ThoughtSegment,
  TodoItem,
  ToolSegment,
  ToolStatus,
} from '../../types'

export type AssistantFlowBlock =
  | { kind: 'thought'; id: string; segment: ThoughtSegment }
  | { kind: 'text'; id: string; content: string; streaming: boolean }
  | { kind: 'tool_group'; id: string; title: string; status: ToolStatus; tools: ToolSegment[]; durationMs?: number }
  | { kind: 'control'; id: string; segment: AskSegment | PlanSegment }
  | { kind: 'todos'; id: string; todos: TodoItem[] }

const THOUGHT_MIN_DURATION_MS = 120

export function projectAssistantFlow(message: AssistantMessage): AssistantFlowBlock[] {
  const visible = message.segments.filter(visibleSegment)
  const blocks: AssistantFlowBlock[] = []

  for (let index = 0; index < visible.length;) {
    const segment = visible[index]
    if (!segment) {
      index += 1
      continue
    }

    if (segment.type === 'thought') {
      blocks.push({ kind: 'thought', id: segment.id, segment })
      index += 1
      continue
    }

    if (segment.type === 'text') {
      const group: typeof segment[] = []
      let cursor = index
      while (visible[cursor]?.type === 'text') {
        group.push(visible[cursor] as typeof segment)
        cursor += 1
      }
      blocks.push({
        kind: 'text',
        id: `text-${group.map((item) => item.id).join('-')}`,
        content: group.map((item) => item.content).filter(Boolean).join('\n\n'),
        streaming: Boolean(message.streaming && cursor === visible.length),
      })
      index = cursor
      continue
    }

    if (segment.type === 'tool') {
      const group: ToolSegment[] = []
      let cursor = index
      while (visible[cursor]?.type === 'tool') {
        group.push(visible[cursor] as ToolSegment)
        cursor += 1
      }
      blocks.push({
        kind: 'tool_group',
        id: `tool-group-${group.map((item) => item.toolId || item.id).join('-')}`,
        title: toolGroupTitle(group),
        status: toolGroupStatus(group),
        tools: group,
        durationMs: toolGroupDuration(group),
      })
      index = cursor
      continue
    }

    if (segment.type === 'ask' || segment.type === 'plan') {
      blocks.push({ kind: 'control', id: segment.id, segment })
      index += 1
      continue
    }

    index += 1
  }

  if (message.todos?.length && !visible.some((segment) => segment.type === 'tool' && Boolean(segment.todos?.length))) {
    blocks.push({ kind: 'todos', id: 'todos-fallback', todos: message.todos })
  }

  return blocks
}

function visibleSegment(segment: AssistantSegment) {
  if (segment.type !== 'thought') return true
  if (segment.status === 'running') return true
  return (segment.durationMs || 0) >= THOUGHT_MIN_DURATION_MS
}

function toolGroupStatus(tools: ToolSegment[]): ToolStatus {
  if (tools.some((tool) => tool.status === 'error')) return 'error'
  if (tools.some((tool) => tool.status === 'error_aborted')) return 'error_aborted'
  if (tools.some((tool) => tool.status === 'running')) return 'running'
  return 'done'
}

function toolGroupTitle(tools: ToolSegment[]) {
  if (tools.length === 1) {
    const tool = tools[0]
    return `${toolLabel(tool)} · ${toolPurpose(tool.name)}`
  }

  const labels = new Set(tools.map(toolLabel))
  if (labels.size === 1) {
    const first = tools[0]
    return `${toolLabel(first)} × ${tools.length} · ${toolPurpose(first.name)}`
  }

  return `执行 ${tools.length} 个工具`
}

function toolGroupDuration(tools: ToolSegment[]) {
  const started = tools
    .map((tool) => tool.startedAt)
    .filter((value): value is number => typeof value === 'number')
  const ended = tools
    .map((tool) => tool.endedAt)
    .filter((value): value is number => typeof value === 'number')
  if (started.length && ended.length) {
    return Math.max(0, Math.max(...ended) - Math.min(...started))
  }

  const total = tools.reduce((sum, tool) => sum + Math.max(0, Number(tool.durationMs || 0)), 0)
  return total || undefined
}

function toolLabel(tool: ToolSegment) {
  return tool.displayName || toolName(tool.name)
}

function toolName(name: string) {
  const names: Record<string, string> = {
    dispatch_subagent: 'Agent',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Search',
    load_skill: 'Skill',
    read_file: 'Read',
    run_command: 'Bash',
    scheduler: 'Scheduler',
    update_todos: 'Update Todos',
    web_fetch: 'Fetch',
    write_file: 'Write',
  }
  return names[name] || name
}

function toolPurpose(name: string) {
  const purposes: Record<string, string> = {
    dispatch_subagent: '派遣子代理',
    edit_file: '修改文件',
    glob: '匹配路径',
    grep: '搜索文本',
    load_skill: '加载 Skill',
    read_file: '读取文件',
    run_command: '执行命令',
    scheduler: '调度任务',
    update_todos: '更新计划',
    web_fetch: '读取网页',
    write_file: '写入文件',
  }
  return purposes[name] || '工具执行'
}
