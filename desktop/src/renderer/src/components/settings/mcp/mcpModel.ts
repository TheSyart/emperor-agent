/**
 * 能力 › MCP view model: pure mapping from Core's masked
 * `mcp_config.json` view + `mcp.status` snapshot + bootstrap tool list to
 * server cards, the import preview rows, and the 「表单」 tab's raw builder.
 * No Vue, no IPC — McpSection / McpAddDialog own the effects.
 */
import type { DefinitionItem } from '../ui/types'

export type McpTransportKind = 'stdio' | 'sse' | 'http'

/** One server of the masked config view (`mcp.getConfig`). */
export interface McpServerConfigLike {
  transport?: string | null
  type?: string | null
  enabled?: boolean
  disabled?: boolean
  command?: string | null
  args?: readonly string[] | null
  env?: Readonly<Record<string, string>> | null
  url?: string | null
  headers?: Readonly<Record<string, string>> | null
}

export interface McpConfigLike {
  servers?: Readonly<Record<string, McpServerConfigLike>> | null
}

/** One connection of the `mcp.status` snapshot. */
export interface McpServerStatusLike {
  serverName: string
  transport?: string
  state: string
  toolCount?: number
  tools?: readonly string[]
  lastError?: { code?: string; message?: string } | null
}

export interface McpStatusLike {
  servers: readonly McpServerStatusLike[]
  ready?: number
  configured?: number
  tools?: number
}

/** A bootstrap tool (`boot.tools`); MCP tools carry `source: 'mcp'` + server. */
export interface McpToolLike {
  name: string
  description?: string
  source?: string
  server?: string
}

export type McpCardState =
  'connected' | 'connecting' | 'failed' | 'disabled' | 'idle'
export type McpTone = 'ok' | 'warn' | 'error' | 'neutral'

export interface McpServerTool {
  /** The server-side tool name (without the `mcp_<server>_` prefix). */
  name: string
  description: string
}

export interface McpServerView {
  name: string
  transport: McpTransportKind
  enabled: boolean
  state: McpCardState
  stateLabel: string
  tone: McpTone
  /** Masked URL (remote) or command line (stdio), secrets shown as ***. */
  target: string
  toolCount: number
  tools: McpServerTool[]
  lastError: { code: string; message: string } | null
  headerKeys: string[]
  envKeys: string[]
}

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const HTTP_ALIASES = new Set([
  'http',
  'streamable-http',
  'streamablehttp',
  'streamable_http',
  'remote',
])

/** Effective transport, matching Core's import normalization. */
export function mcpTransportOf(config: McpServerConfigLike): McpTransportKind {
  const declared = String(config.transport ?? config.type ?? '')
    .trim()
    .toLowerCase()
  if (declared === 'sse') return 'sse'
  if (HTTP_ALIASES.has(declared)) return 'http'
  if (declared === 'stdio' || declared === 'local') return 'stdio'
  return config.url && !config.command ? 'http' : 'stdio'
}

export function mcpTransportLabel(transport: string): string {
  if (transport === 'http') return 'HTTP'
  if (transport === 'sse') return 'SSE'
  if (transport === 'stdio') return 'stdio'
  return transport || '—'
}

export function mcpTransportDescription(transport: string): string {
  if (transport === 'http') return 'Streamable HTTP（失败时回退 SSE）'
  if (transport === 'sse') return 'SSE'
  if (transport === 'stdio') return 'stdio（本地进程）'
  return transport || '—'
}

/** Card state: disabled wins; otherwise the connection state from mcp.status. */
export function mcpCardState(
  enabled: boolean,
  status?: Pick<McpServerStatusLike, 'state'> | null,
): { state: McpCardState; label: string; tone: McpTone } {
  if (!enabled) return { state: 'disabled', label: '已停用', tone: 'neutral' }
  switch (status?.state) {
    case 'ready':
      return { state: 'connected', label: '已连接', tone: 'ok' }
    case 'connecting':
      return { state: 'connecting', label: '连接中', tone: 'warn' }
    case 'backoff':
      return { state: 'connecting', label: '等待重试', tone: 'warn' }
    case 'degraded':
      return { state: 'failed', label: '连接异常', tone: 'error' }
    case 'auth_failed':
      return { state: 'failed', label: '认证失败', tone: 'error' }
    case 'failed':
      return { state: 'failed', label: '连接失败', tone: 'error' }
    default:
      return { state: 'idle', label: '未连接', tone: 'neutral' }
  }
}

/** Core masks every secret leaf as `[REDACTED]`; cards show a compact `***`. */
export function displaySecretText(value: string): string {
  return value.replace(/\[REDACTED\]|%5BREDACTED%5D/gi, '***')
}

export function mcpServerTarget(config: McpServerConfigLike): string {
  const transport = mcpTransportOf(config)
  const text =
    transport === 'stdio'
      ? [config.command ?? '', ...(config.args ?? [])].filter(Boolean).join(' ')
      : (config.url ?? '')
  return displaySecretText(text)
}

function isEnabled(config: McpServerConfigLike): boolean {
  return config.enabled !== false && config.disabled !== true
}

function serverTools(
  name: string,
  enabled: boolean,
  status: McpServerStatusLike | undefined,
  tools: readonly McpToolLike[],
): McpServerTool[] {
  if (!enabled) return []
  const prefix = `mcp_${name}_`
  const described = new Map<string, string>()
  for (const tool of tools) {
    if (tool.source !== 'mcp' || tool.server !== name) continue
    const short = tool.name.startsWith(prefix)
      ? tool.name.slice(prefix.length)
      : tool.name
    described.set(short, tool.description ?? '')
  }
  const names = status?.tools?.length
    ? [...status.tools]
    : [...described.keys()]
  return names.map((toolName) => ({
    name: toolName,
    description: described.get(toolName) ?? '',
  }))
}

/** Join config (source of truth for the list), status and tools into cards. */
export function buildMcpServerViews(
  config: McpConfigLike | null | undefined,
  status: McpStatusLike | null | undefined,
  tools: readonly McpToolLike[] = [],
): McpServerView[] {
  const byName = new Map(
    (status?.servers ?? []).map((item) => [item.serverName, item]),
  )
  return Object.entries(config?.servers ?? {}).map(([name, server]) => {
    const enabled = isEnabled(server)
    const connection = byName.get(name)
    const state = mcpCardState(enabled, connection)
    const list = serverTools(name, enabled, connection, tools)
    const error = enabled ? connection?.lastError : null
    return {
      name,
      transport: mcpTransportOf(server),
      enabled,
      state: state.state,
      stateLabel: state.label,
      tone: state.tone,
      target: mcpServerTarget(server),
      toolCount: enabled
        ? Math.max(connection?.toolCount ?? 0, list.length)
        : 0,
      tools: list,
      lastError: error?.message
        ? { code: error.code ?? '', message: error.message }
        : null,
      headerKeys: Object.keys(server.headers ?? {}),
      envKeys: Object.keys(server.env ?? {}),
    }
  })
}

/** Card subtitle: state · tool count (· short failure reason). */
export function mcpServerSummary(view: McpServerView): string {
  const parts = [view.stateLabel]
  if (view.state === 'connected' || view.toolCount > 0)
    parts.push(`${view.toolCount} 个工具`)
  if (view.state === 'failed' && view.lastError)
    parts.push(view.lastError.message)
  return parts.join(' · ')
}

/** The expanded card's facts (DefinitionList). */
export function mcpServerFacts(view: McpServerView): DefinitionItem[] {
  const remote = view.transport !== 'stdio'
  const items: DefinitionItem[] = [
    { term: '传输', value: mcpTransportDescription(view.transport) },
    {
      key: 'target',
      term: remote ? '地址' : '命令',
      value: view.target,
      mono: true,
    },
  ]
  if (remote && view.headerKeys.length)
    items.push({
      term: '请求头',
      value: view.headerKeys.join(', '),
      mono: true,
    })
  if (!remote && view.envKeys.length)
    items.push({ term: '环境变量', value: view.envKeys.join(', '), mono: true })
  items.push({ term: '状态', value: view.stateLabel })
  if (view.lastError)
    items.push({
      key: 'error',
      term: '最近错误',
      value: view.lastError.code
        ? `${view.lastError.message}（${view.lastError.code}）`
        : view.lastError.message,
    })
  return items
}

/** Why a card has no tools to list. */
export function mcpEmptyToolsText(view: McpServerView): string {
  if (view.state === 'disabled') return '已停用，启用后会重新连接并加载工具。'
  if (view.state === 'connecting') return '正在连接，连接成功后显示工具。'
  if (view.state === 'failed') return '连接未成功，尚未加载工具。'
  if (view.state === 'idle') return '尚未连接，点击刷新查看最新状态。'
  return '连接已建立，但 server 没有公布可用工具。'
}

// ── import preview ────────────────────────────────────────────────────

/** One server of an `mcp.importServers` plan. */
export interface McpImportServerLike {
  name: string
  transport: string
  target: string
  action: 'add' | 'update' | 'skip' | string
  conflict: boolean
}

export interface McpImportPlanLike {
  added: readonly string[]
  updated: readonly string[]
  skipped: readonly string[]
  warnings: readonly string[]
  servers: readonly McpImportServerLike[]
}

/**
 * Effective per-server outcome. The preview runs with `overwrite: true`, so
 * a conflict that Core would change reports `update`; whether it really
 * updates depends on the row's 「覆盖」 checkbox. A conflict Core still skips
 * is identical to the stored config (`same`).
 */
export type McpPreviewKind = 'add' | 'update' | 'skip' | 'same'

export interface McpPreviewRow {
  name: string
  transport: string
  target: string
  kind: McpPreviewKind
  /** Conflict that the user may choose to overwrite. */
  overwritable: boolean
  overwrite: boolean
}

export function mcpPreviewRows(
  plan: McpImportPlanLike | null | undefined,
  overwrite: readonly string[] = [],
): McpPreviewRow[] {
  const selected = new Set(overwrite)
  return (plan?.servers ?? []).map((server) => {
    const overwritable = server.conflict && server.action === 'update'
    const chosen = overwritable && selected.has(server.name)
    let kind: McpPreviewKind
    if (!server.conflict && server.action === 'add') kind = 'add'
    else if (overwritable) kind = chosen ? 'update' : 'skip'
    else kind = 'same'
    return {
      name: server.name,
      transport: server.transport,
      target: displaySecretText(server.target),
      kind,
      overwritable,
      overwrite: chosen,
    }
  })
}

export function mcpPreviewKindLabel(kind: McpPreviewKind): string {
  if (kind === 'add') return '新增'
  if (kind === 'update') return '覆盖'
  if (kind === 'same') return '已存在（相同）'
  return '跳过'
}

export function mcpPreviewKindTone(kind: McpPreviewKind): McpTone {
  if (kind === 'add') return 'ok'
  if (kind === 'update') return 'warn'
  return 'neutral'
}

/** Rows that the import would actually write. */
export function mcpImportableCount(rows: readonly McpPreviewRow[]): number {
  return rows.filter((row) => row.kind === 'add' || row.kind === 'update')
    .length
}

/** Only names that are still overwritable conflicts in the latest plan. */
export function pruneOverwrite(
  plan: McpImportPlanLike | null | undefined,
  overwrite: readonly string[],
): string[] {
  const allowed = new Set(
    (plan?.servers ?? [])
      .filter((server) => server.conflict && server.action === 'update')
      .map((server) => server.name),
  )
  return overwrite.filter((name) => allowed.has(name))
}

/** Toast after a real import: 新增 / 更新 / 跳过 counts. */
export function mcpImportSummary(plan: McpImportPlanLike): string {
  const parts: string[] = []
  if (plan.added.length) parts.push(`新增 ${plan.added.length} 个`)
  if (plan.updated.length) parts.push(`更新 ${plan.updated.length} 个`)
  if (plan.skipped.length) parts.push(`跳过 ${plan.skipped.length} 个`)
  if (!plan.added.length && !plan.updated.length)
    return parts.length
      ? `没有写入任何 MCP 服务器（${parts.join('，')}）`
      : '没有写入任何 MCP 服务器'
  return `已导入 MCP 服务器：${parts.join('，')}`
}

// ── 表单 tab ──────────────────────────────────────────────────────────

export interface McpKeyValueRow {
  id: number
  key: string
  value: string
}

export interface McpServerFormState {
  name: string
  transport: McpTransportKind
  url: string
  headers: McpKeyValueRow[]
  command: string
  args: string
  env: McpKeyValueRow[]
}

export interface McpServerFormErrors {
  name?: string
  url?: string
  command?: string
}

export function emptyMcpServerForm(): McpServerFormState {
  return {
    name: '',
    transport: 'http',
    url: '',
    headers: [],
    command: '',
    args: '',
    env: [],
  }
}

/** Shell-like split: whitespace separated, '…' / "…" group, \\ escapes. */
export function splitCommandLine(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < text.length)
        current += text[++index]
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < text.length) {
      current += text[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) out.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) out.push(current)
  return out
}

function isRemoteUrl(value: string): boolean {
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Field errors; only reported for fields the user has typed into or on submit. */
export function validateMcpServerForm(
  form: McpServerFormState,
): McpServerFormErrors {
  const errors: McpServerFormErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = '请填写名称'
  else if (!MCP_SERVER_NAME_RE.test(name))
    errors.name = '只能包含字母、数字、- 和 _，且以字母或数字开头'
  if (form.transport === 'stdio') {
    if (!form.command.trim()) errors.command = '请填写启动命令'
  } else {
    const url = form.url.trim()
    if (!url) errors.url = '请填写服务地址'
    else if (!isRemoteUrl(url))
      errors.url = '地址必须以 http:// 或 https:// 开头'
  }
  return errors
}

function keyValueRecord(
  rows: readonly McpKeyValueRow[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

/**
 * Build the Claude-style `{ mcpServers: { <name>: … } }` object the import op
 * accepts, or null while the form is invalid. A command typed with its
 * arguments (`npx -y pkg`) is split into command + args.
 */
export function buildMcpServerRaw(
  form: McpServerFormState,
): { mcpServers: Record<string, Record<string, unknown>> } | null {
  if (Object.keys(validateMcpServerForm(form)).length) return null
  const name = form.name.trim()
  let server: Record<string, unknown>
  if (form.transport === 'stdio') {
    const [command = '', ...inline] = splitCommandLine(form.command.trim())
    const args = [...inline, ...splitCommandLine(form.args)]
    const env = keyValueRecord(form.env)
    server = { type: 'stdio', command }
    if (args.length) server.args = args
    if (Object.keys(env).length) server.env = env
  } else {
    const headers = keyValueRecord(form.headers)
    server = { type: form.transport, url: form.url.trim() }
    if (Object.keys(headers).length) server.headers = headers
  }
  return { mcpServers: { [name]: server } }
}
