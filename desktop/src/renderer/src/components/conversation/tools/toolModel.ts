// Pure readers over a chat `tool` node (dsh ui-tool models, Emperor tool
// vocabulary): parsed arguments, result text/meta, the row state, and the
// per-tool card material (terminal, read window, search groups, diffs).
import type { DiffHunk } from '../../ui/diffRows'
import type {
  ReadBlockLine,
  SearchFileGroup,
  WebSource,
} from '../../ui/blockTypes'
import type { ToolChatData } from '../../../conversation/types'

/** Row run-state (dsh ToolRowState). */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

export type ToolArgs = Record<string, unknown>

const argsCache = new Map<string, ToolArgs | null>()
const ARGS_CACHE_LIMIT = 256

/** Parsed JSON arguments; null when truncated/malformed or not an object. */
export function parseToolArgs(argsRaw: string): ToolArgs | null {
  const cached = argsCache.get(argsRaw)
  if (cached !== undefined) return cached
  let parsed: ToolArgs | null = null
  try {
    const value: unknown = JSON.parse(argsRaw)
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      parsed = value as ToolArgs
  } catch {
    parsed = null
  }
  if (argsCache.size >= ARGS_CACHE_LIMIT) argsCache.clear()
  argsCache.set(argsRaw, parsed)
  return parsed
}

export function argsOf(data: ToolChatData): ToolArgs {
  return parseToolArgs(data.argsRaw) ?? {}
}

export function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function numberArg(args: ToolArgs, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function boolArg(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Result meta as a plain record (undefined while running / absent). */
export function metaOf(
  data: ToolChatData,
): Record<string, unknown> | undefined {
  const meta: unknown = data.result?.meta
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined
}

/** Joined text blocks of the settled result ('' while running). */
export function resultText(data: ToolChatData): string {
  const content = data.result?.content ?? []
  let text = ''
  for (const block of content) {
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

export function firstLine(text: string): string {
  const trimmed = text.trim()
  const newline = trimmed.indexOf('\n')
  return newline === -1 ? trimmed : trimmed.slice(0, newline)
}

export function lastLine(text: string): string {
  const trimmed = text.trimEnd()
  const newline = trimmed.lastIndexOf('\n')
  return (newline === -1 ? trimmed : trimmed.slice(newline + 1)).trim()
}

/** Terminal/background shell failure: a settled non-zero exit is an error. */
function shellFailed(data: ToolChatData): boolean {
  if (data.name !== 'bash') return false
  const meta = metaOf(data)
  if (meta?.kind !== 'foreground') return false
  const exit = meta.exitCode
  return (
    (typeof exit === 'number' && exit !== 0) ||
    (typeof meta.signal === 'string' && meta.signal !== '') ||
    meta.timedOut === true
  )
}

/** Row state: running / interrupted (stopped) / error / ok. */
export function toolRowState(data: ToolChatData): ToolRowState {
  if (data.status === 'running') return 'running'
  if (data.status === 'interrupted') return 'stopped'
  if (data.result?.isError === true) return 'error'
  if (shellFailed(data)) return 'error'
  const reason = data.subagent?.stopReason
  if (reason === 'error' || reason === 'refusal') return 'error'
  if (reason === 'aborted' || reason === 'interrupted') return 'stopped'
  return 'ok'
}

/** First line of the failure for an error row (dsh errorSummary). */
export function errorSummary(data: ToolChatData): string | null {
  if (toolRowState(data) !== 'error') return null
  if (data.result?.isError === true) {
    const line = firstLine(resultText(data))
    return line === '' ? (data.result.error?.code ?? '执行失败') : line
  }
  const shell = shellOutcome(data)
  if (shell.signal !== undefined) return `被信号 ${shell.signal} 终止`
  if (shell.timedOut) return '执行超时'
  if (shell.exitCode !== undefined) return `退出码 ${shell.exitCode}`
  return null
}

/** Display path: keep the last three segments of long absolute paths. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/u).filter((part) => part !== '')
  if (parts.length <= 3) return path
  return `…/${parts.slice(-3).join('/')}`
}

export function truncate(text: string, max = 120): string {
  const single = text.replace(/\s+/gu, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

// ── bash ────────────────────────────────────────────────────────────────

export interface ShellOutcome {
  /** Output with the trailing kernel markers removed. */
  output: string
  exitCode?: number
  signal?: string
  timedOut: boolean
  background: boolean
  jobId?: string
}

const SHELL_MARKER =
  /^\[(?:exit code: (-?\d+|null)|killed by signal: ([\w-]+)|timed out after \d+ms)\]$/u

export function shellOutcome(data: ToolChatData): ShellOutcome {
  const meta = metaOf(data)
  const background = meta?.kind === 'background'
  const lines = resultText(data).split('\n')
  let exitCode: number | undefined
  let signal: string | undefined
  let timedOut = false
  while (lines.length > 0) {
    const match = SHELL_MARKER.exec(lines.at(-1)?.trim() ?? '')
    if (match === null) break
    lines.pop()
    if (match[1] !== undefined && match[1] !== 'null')
      exitCode = Number(match[1])
    if (match[2] !== undefined) signal = match[2]
    if (match[0].startsWith('[timed out')) timedOut = true
  }
  if (typeof meta?.exitCode === 'number') exitCode = meta.exitCode
  if (typeof meta?.signal === 'string') signal = meta.signal
  if (meta?.timedOut === true) timedOut = true
  let output = lines.join('\n')
  if (output === '(no output)') output = ''
  if (background) output = ''
  if (!background && exitCode === undefined && data.status === 'settled')
    exitCode = data.result?.isError === true ? undefined : 0
  return {
    output,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    timedOut,
    background,
    ...(typeof meta?.jobId === 'string' ? { jobId: meta.jobId } : {}),
  }
}

export const JOB_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  killed: '已停止',
  failed: '失败',
}

// ── read ────────────────────────────────────────────────────────────────

export interface ReadWindow {
  path: string
  lines: ReadBlockLine[]
  totalLines: number
}

/** `N: text` lines inside the read tool's `<content>` envelope. */
export function readWindow(data: ToolChatData): ReadWindow | null {
  if (data.result === undefined || data.result.isError) return null
  const text = resultText(data)
  const open = text.indexOf('<content>\n')
  const close = text.lastIndexOf('\n</content>')
  if (open < 0 || close < open) return null
  const body = text.slice(open + '<content>\n'.length, close)
  const lines: ReadBlockLine[] = []
  for (const raw of body.split('\n')) {
    const match = /^(\d+): ?(.*)$/su.exec(raw)
    if (match === null) {
      if (lines.length > 0 && raw !== '') break
      continue
    }
    lines.push({ number: Number(match[1]), text: match[2] ?? '' })
  }
  const meta = metaOf(data)
  const path =
    (typeof meta?.path === 'string' ? meta.path : undefined) ??
    /<path>(.*)<\/path>/u.exec(text)?.[1] ??
    stringArg(argsOf(data), 'file_path') ??
    ''
  const totalLines =
    typeof meta?.totalLines === 'number'
      ? meta.totalLines
      : (lines.at(-1)?.number ?? 0)
  return { path, lines, totalLines }
}

// ── search ──────────────────────────────────────────────────────────────

export interface GrepCard {
  files: SearchFileGroup[]
  truncated: boolean
  total?: number
  recovery?: string
}

/** Parse the grep result (`path` + `Line N: text` groups). */
export function grepCard(data: ToolChatData): GrepCard | null {
  if (data.result === undefined || data.result.isError) return null
  const text = resultText(data)
  if (text.trim() === 'No matches found') return { files: [], truncated: false }
  const sections = text.split('\n\n')
  const header = sections.shift() ?? ''
  const files: SearchFileGroup[] = []
  let recovery: string | undefined
  for (const section of sections) {
    const lines = section.split('\n')
    const path = lines[0] ?? ''
    if (path.startsWith('(')) {
      recovery = section.replace(/^\(|\)$/gu, '')
      continue
    }
    const matches = lines.slice(1).flatMap((line) => {
      const match = /^Line (\d+): (.*)$/su.exec(line)
      return match === null
        ? []
        : [{ lineNumber: Number(match[1]), line: match[2] ?? '' }]
    })
    if (matches.length > 0) files.push({ path, matches })
  }
  const meta = metaOf(data)
  const total =
    typeof meta?.matches === 'number'
      ? meta.matches
      : Number(/Found (?:\d+ of )?(\d+)/u.exec(header)?.[1] ?? NaN)
  const truncated = meta?.truncated === true
  return {
    files,
    truncated,
    ...(Number.isFinite(total) ? { total } : {}),
    ...(recovery === undefined ? {} : { recovery }),
  }
}

export interface GlobCard {
  paths: string[]
  truncated: boolean
  total: number
}

export function globCard(data: ToolChatData): GlobCard | null {
  if (data.result === undefined || data.result.isError) return null
  const meta = metaOf(data)
  const text = resultText(data)
  let paths: string[]
  if (Array.isArray(meta?.files))
    paths = meta.files.filter(
      (item): item is string => typeof item === 'string',
    )
  else if (text.trim() === 'No files found') paths = []
  else
    paths = (text.split('\n\n')[0] ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '')
  const total = typeof meta?.matches === 'number' ? meta.matches : paths.length
  return { paths, truncated: meta?.truncated === true, total }
}

// ── web ─────────────────────────────────────────────────────────────────

export interface WebCard {
  answer?: string
  sources: WebSource[]
  truncated: boolean
}

export function webCard(data: ToolChatData): WebCard | null {
  if (data.result === undefined || data.result.isError) return null
  const meta = metaOf(data)
  if (meta === undefined) return null
  const sources = Array.isArray(meta.sources)
    ? meta.sources.flatMap((raw): WebSource[] => {
        if (typeof raw !== 'object' || raw === null) return []
        const source = raw as Record<string, unknown>
        if (typeof source.url !== 'string') return []
        return [
          {
            url: source.url,
            ...(typeof source.title === 'string'
              ? { title: source.title }
              : {}),
            ...(typeof source.snippet === 'string'
              ? { snippet: source.snippet }
              : {}),
            ...(typeof source.publishedAt === 'string'
              ? { publishedAt: source.publishedAt }
              : {}),
          },
        ]
      })
    : []
  return {
    sources,
    truncated: meta.truncated === true,
    ...(typeof meta.answer === 'string' ? { answer: meta.answer } : {}),
  }
}

// ── file mutations ──────────────────────────────────────────────────────

/** Split a unified diff (`@@` hunks) into DiffBlock hunks. */
export function hunksFromUnifiedDiff(diff: string, path: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let old: string[] | null = null
  let next: string[] = []
  const flush = (): void => {
    if (old !== null)
      hunks.push({
        path,
        oldText: old.length === 0 ? '' : `${old.join('\n')}\n`,
        newText: next.length === 0 ? '' : `${next.join('\n')}\n`,
      })
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      old = []
      next = []
      continue
    }
    if (old === null) continue
    if (line.startsWith('\\')) continue
    const kind = line[0]
    const text = line.slice(1)
    if (kind === ' ') {
      old.push(text)
      next.push(text)
    } else if (kind === '-') old.push(text)
    else if (kind === '+') next.push(text)
  }
  flush()
  return hunks
}

const MEMORY_TARGET_LABEL: Record<string, string> = {
  memory: '长期记忆',
  user: '用户档案',
  project: '项目记忆',
}

export function memoryTargetLabel(target: string | undefined): string {
  return (target && MEMORY_TARGET_LABEL[target]) ?? target ?? '记忆'
}

/** Diff material for write / edit / memory_edit. */
export function mutationHunks(data: ToolChatData): DiffHunk[] | null {
  const args = argsOf(data)
  const meta = metaOf(data)
  if (data.result?.isError === true) return null
  if (data.name === 'memory_edit') {
    const newText = stringArg(args, 'new_string')
    if (newText === undefined) return null
    const path = memoryTargetLabel(stringArg(args, 'target'))
    const oldText = stringArg(args, 'old_string')
    return [{ path, oldText: oldText ?? '', newText }]
  }
  const path =
    (typeof meta?.path === 'string' ? meta.path : undefined) ??
    stringArg(args, 'file_path') ??
    ''
  if (typeof meta?.diff === 'string' && meta.diff !== '') {
    const hunks = hunksFromUnifiedDiff(meta.diff, path)
    if (hunks.length > 0) return hunks
  }
  if (data.name === 'edit') {
    const oldText = stringArg(args, 'old_string')
    const newText = stringArg(args, 'new_string')
    if (oldText === undefined || newText === undefined) return null
    return [{ path, oldText, newText }]
  }
  if (data.name === 'write') {
    const content = stringArg(args, 'content')
    if (content === undefined) return null
    return [{ path, oldText: null, newText: content }]
  }
  return null
}

// ── todo ────────────────────────────────────────────────────────────────

export interface TodoView {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export function todoItems(data: ToolChatData): TodoView[] | null {
  const todos = argsOf(data).todos
  if (!Array.isArray(todos)) return null
  return todos.flatMap((raw): TodoView[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const item = raw as Record<string, unknown>
    if (typeof item.content !== 'string') return []
    const status =
      item.status === 'completed' || item.status === 'in_progress'
        ? item.status
        : 'pending'
    return [{ content: item.content, status }]
  })
}

// ── plan ────────────────────────────────────────────────────────────────

export function planTitle(plan: string): string | undefined {
  const match = /^\s*#\s+(.+)$/mu.exec(plan)
  return match?.[1]?.trim()
}

export type PlanOutcome =
  | 'waiting'
  | 'approved'
  | 'keep-planning'
  | 'cancelled'
  | 'unavailable'
  | 'failed'
  | 'stopped'

export function planOutcome(data: ToolChatData): {
  outcome: PlanOutcome
  feedback?: string
} {
  if (data.status === 'running') return { outcome: 'waiting' }
  if (data.status === 'interrupted') return { outcome: 'stopped' }
  const meta = metaOf(data)
  if (meta?.approved === true) return { outcome: 'approved' }
  const code = data.result?.error?.code
  const text = resultText(data)
  if (code === 'PLAN_REJECTED') {
    const feedback = /their feedback: ([\s\S]*)$/u.exec(text)?.[1]?.trim()
    return {
      outcome: 'keep-planning',
      ...(feedback === undefined ? {} : { feedback }),
    }
  }
  if (code === 'PLAN_REVIEW_CANCELLED') return { outcome: 'cancelled' }
  if (code === 'PLAN_REVIEW_UNAVAILABLE') return { outcome: 'unavailable' }
  if (data.result?.isError === true) return { outcome: 'failed' }
  return { outcome: 'approved' }
}

export const PLAN_OUTCOME_LABEL: Record<PlanOutcome, string> = {
  waiting: '等待审阅',
  approved: '已批准',
  'keep-planning': '继续规划',
  cancelled: '已取消',
  unavailable: '无法审阅',
  failed: '失败',
  stopped: '已中断',
}

// ── ask_user_question ───────────────────────────────────────────────────

export interface QuestionItemView {
  id: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  selected: string[]
  custom?: string
}

export function questionItems(data: ToolChatData): QuestionItemView[] {
  const asked = data.question?.questions
  const raw: unknown[] = Array.isArray(asked)
    ? [...asked]
    : Array.isArray(argsOf(data).questions)
      ? (argsOf(data).questions as unknown[])
      : []
  const answers = (data.question?.answers ?? {}) as Record<
    string,
    { selected?: unknown; custom?: unknown }
  >
  return raw.flatMap((entry): QuestionItemView[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    const answer = answers[id]
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (typeof option !== 'object' || option === null) return []
          const o = option as Record<string, unknown>
          if (typeof o.label !== 'string') return []
          return [
            {
              label: o.label,
              ...(typeof o.description === 'string'
                ? { description: o.description }
                : {}),
            },
          ]
        })
      : []
    const selected = Array.isArray(answer?.selected)
      ? answer.selected.filter((s): s is string => typeof s === 'string')
      : []
    return [
      {
        id,
        question: typeof item.question === 'string' ? item.question : '',
        ...(typeof item.header === 'string' ? { header: item.header } : {}),
        options,
        multiSelect: item.multiSelect === true || item.multi_select === true,
        selected,
        ...(typeof answer?.custom === 'string' && answer.custom !== ''
          ? { custom: answer.custom }
          : {}),
      },
    ]
  })
}

// ── generic ─────────────────────────────────────────────────────────────

/** First short string argument, for rows without a dedicated summary. */
export function argsPreview(args: ToolArgs): string {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim() !== '')
      return truncate(value, 96)
  }
  const keys = Object.keys(args)
  return keys.length === 0 ? '' : truncate(JSON.stringify(args), 96)
}

/** Result text parsed as JSON when it looks like JSON (MCP / generic OUT). */
export function resultValue(data: ToolChatData): unknown {
  const text = resultText(data)
  const trimmed = text.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return text
    }
  }
  return text
}

/** `mcp_<server>_<tool>` → server / tool (meta wins when present). */
export function mcpIdentity(
  data: ToolChatData,
): { server: string; tool: string } | null {
  const meta = metaOf(data)
  if (typeof meta?.server === 'string' && typeof meta.tool === 'string')
    return { server: meta.server, tool: meta.tool }
  if (!data.name.startsWith('mcp_')) return null
  const rest = data.name.slice(4)
  const split = rest.indexOf('_')
  if (split <= 0) return { server: rest, tool: rest }
  return { server: rest.slice(0, split), tool: rest.slice(split + 1) }
}
