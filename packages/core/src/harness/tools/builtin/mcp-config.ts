/**
 * `mcp_config`: model-facing management of Emperor's own MCP server config
 * (`<Emperor Home>/mcp_config.json`). Actions: list / add / remove / enable /
 * disable / reload. `add` accepts the same pasted JSON as the settings page
 * (Claude Desktop / Cursor `mcpServers`, VS Code / Emperor `servers`, one
 * named server). Writes follow the session's permission preset: outside
 * `danger-full-access` the user approves each write through the approval
 * service (the same ask card as sandbox escalation). After a write the MCP
 * client reloads, so new `mcp_<server>_<tool>` tools appear next step.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { MCPClientSnapshot } from '../../../mcp/client'
import {
  loadMcpConfig,
  maskSecretUrl,
  MCP_CONFIG_FILE,
  type ServerConfig,
} from '../../../mcp/config'
import {
  importMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  type McpImportPlan,
} from '../../../mcp/manage'
import type { Agent } from '../../agent/agent'
import type { ApprovalService } from '../../approval/service'
import type { SystemPromptAssembler } from '../../prompt/assembler'
import type { SandboxPolicyService } from '../../sandbox/policy'
import { defineTool, ToolError, type ToolDefinition } from '../definition'

export interface McpConfigToolDeps {
  /** Emperor Home (directory holding `mcp_config.json`). */
  stateRoot: string
  sandbox: SandboxPolicyService
  approval: ApprovalService | undefined
  /** Reload the MCP client and resync the `mcp_*` tools. */
  reload(): Promise<void>
  status(): MCPClientSnapshot
}

const DESCRIPTION =
  '管理 Emperor 自己的 MCP server 配置（Emperor Home 下的 mcp_config.json；Emperor 只读取这一个文件）。' +
  'list 查看 server、transport、状态与工具数；add 传入用户给的 MCP JSON（Claude Desktop / Cursor 的 mcpServers、VS Code 的 servers、或带 name 的单个 server；stdio 用 command/args/env，远程用 url + 可选 headers，type 支持 stdio/sse/http），同名 server 默认跳过，overwrite=true 才覆盖；' +
  'remove / enable / disable 按 name 修改；reload 重新连接全部 server。' +
  '写操作可能需要用户审批；成功后自动重载，新的 mcp_<server>_<tool> 工具从下一步起可用。不要用 mcporter 或编辑其他客户端的配置文件来添加 MCP。'

const mcpConfigInput = z.object({
  action: z
    .enum(['list', 'add', 'remove', 'enable', 'disable', 'reload'])
    .describe('要执行的动作。'),
  config: z
    .union([z.string(), z.looseObject({})])
    .optional()
    .describe(
      'add：MCP 配置 JSON（对象或 JSON 文本），例如 {"mcpServers":{"name":{"type":"http","url":"https://…"}}}。',
    ),
  name: z
    .string()
    .optional()
    .describe(
      'remove/enable/disable：server 名称；add 时可为不带 name 的单个 server 指定名称。',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe('add：同名 server 已存在时是否覆盖（默认 false，跳过）。'),
})

type McpConfigArgs = z.output<typeof mcpConfigInput>

/** Display path of the config file (`~/.emperor/mcp_config.json` for the default home). */
export function mcpConfigDisplayPath(stateRoot: string): string {
  const path = join(stateRoot, MCP_CONFIG_FILE)
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function createMcpConfigTool(
  deps: McpConfigToolDeps,
): ToolDefinition<McpConfigArgs> {
  const displayPath = mcpConfigDisplayPath(deps.stateRoot)

  /** Ask the user unless the calling agent runs under danger-full-access. */
  const authorize = async (
    context: { agent?: Agent; callId: string; signal: AbortSignal },
    reason: string,
  ): Promise<void> => {
    const mode = deps.sandbox.resolve(
      context.agent === undefined ? {} : { session: context.agent.session },
    ).mode
    if (mode === 'danger-full-access') return
    if (deps.approval === undefined || context.agent === undefined)
      throw new ToolError(
        `changing MCP config requires approval under ${mode}, but no approval channel is available`,
        'APPROVAL_UNAVAILABLE',
      )
    const outcome = await deps.approval.request({
      agent: context.agent,
      toolName: 'mcp_config',
      callId: context.callId,
      reason,
      signal: context.signal,
    })
    switch (outcome) {
      case 'allowed-once':
        return
      case 'rejected':
        throw new ToolError(
          'the user rejected this MCP config change',
          'APPROVAL_REJECTED',
        )
      case 'cancelled':
        throw new ToolError(
          'approval for this MCP config change was cancelled',
          'APPROVAL_CANCELLED',
        )
      case 'unavailable':
        throw new ToolError(
          'changing MCP config requires approval, but no approval channel is available',
          'APPROVAL_UNAVAILABLE',
        )
    }
  }

  const reloadReport = async (names: readonly string[]): Promise<string> => {
    try {
      await deps.reload()
    } catch (error: unknown) {
      return `MCP reload failed: ${error instanceof Error ? error.message : String(error)}. The config was saved; retry with action=reload.`
    }
    if (!names.length) return 'MCP reloaded.'
    const byName = new Map(
      deps.status().servers.map((server) => [server.serverName, server]),
    )
    const lines = names.map((name) => {
      const server = byName.get(name)
      if (server === undefined) return `- ${name}: not running (disabled)`
      const tools = server.tools.length
        ? ` · tools: ${server.tools.map((tool) => `mcp_${name}_${tool}`).join(', ')}`
        : ''
      const error = server.lastError ? ` · ${server.lastError.message}` : ''
      return `- ${name}: ${server.state}${tools}${error}`
    })
    return `MCP reloaded.\n${lines.join('\n')}`
  }

  return defineTool({
    name: 'mcp_config',
    description: DESCRIPTION,
    input: mcpConfigInput,
    isConcurrencySafe: (args) => args.action === 'list',
    async execute(args, context) {
      const name = args.name?.trim() ?? ''
      const needsName = (): string => {
        if (!name)
          throw new ToolError(
            `action=${args.action} requires name`,
            'INVALID_ARGUMENT',
          )
        return name
      }
      switch (args.action) {
        case 'list':
          return await formatList(deps, displayPath)
        case 'reload':
          return await reloadReport(
            Object.values((await loadMcpConfig(deps.stateRoot, {})).servers)
              .filter((server) => server.enabled)
              .map((server) => server.name),
          )
        case 'add': {
          if (args.config === undefined)
            throw new ToolError(
              'action=add requires config (MCP server JSON)',
              'INVALID_ARGUMENT',
            )
          const raw = withServerName(args.config, name)
          const overwrite = args.overwrite === true
          const preview = await importMcpServers(deps.stateRoot, raw, {
            overwrite,
            dryRun: true,
          })
          const changing = preview.servers.filter(
            (server) => server.action !== 'skip',
          )
          if (!changing.length) return formatImport(preview, 'No changes.')
          await authorize(
            context,
            `${displayPath} 中${changing
              .map(
                (server) =>
                  `${server.action === 'update' ? '覆盖' : '新增'} MCP server "${server.name}" [${server.transport}] ${server.target}`,
              )
              .join('；')}`,
          )
          const applied = await importMcpServers(deps.stateRoot, raw, {
            overwrite,
          })
          return formatImport(
            applied,
            await reloadReport([...applied.added, ...applied.updated]),
          )
        }
        case 'remove': {
          const server = await storedServer(deps.stateRoot, needsName())
          await authorize(
            context,
            `从 ${displayPath} 删除 MCP server "${name}" [${server.transport}] ${targetOf(server)}`,
          )
          await removeMcpServer(deps.stateRoot, name)
          return `MCP server removed: ${name}.\n${await reloadReport([])}`
        }
        case 'enable':
        case 'disable': {
          const enabled = args.action === 'enable'
          const server = await storedServer(deps.stateRoot, needsName())
          if (server.enabled === enabled)
            return `MCP server ${name} is already ${enabled ? 'enabled' : 'disabled'}.`
          await authorize(
            context,
            `${enabled ? '启用' : '停用'} ${displayPath} 中的 MCP server "${name}" [${server.transport}] ${targetOf(server)}`,
          )
          await setMcpServerEnabled(deps.stateRoot, name, enabled)
          return `MCP server ${enabled ? 'enabled' : 'disabled'}: ${name}.\n${await reloadReport(enabled ? [name] : [])}`
        }
      }
    },
  })
}

export function installMcpConfigPromptSection(
  prompt: SystemPromptAssembler,
  options: { configPath: string },
): () => void {
  return prompt.section({
    name: 'tool:mcp_config',
    order: 118,
    text:
      `Emperor's MCP servers are configured only in Emperor's own ${options.configPath}; Emperor reads no other MCP config. ` +
      'To list, add, remove, enable, disable, or reload MCP servers, use the mcp_config tool — add accepts pasted JSON in Claude Desktop / Cursor (mcpServers), VS Code (servers), or single-server form. ' +
      "Never use mcporter, and never edit other clients' config files (~/.cursor/mcp.json, ~/.claude.json, Claude Desktop's claude_desktop_config.json, VS Code mcp.json) to add servers for Emperor. " +
      'After a change the new mcp_<server>_<tool> tools are available from the next step.\n' +
      'Emperor 的 MCP 配置只有 mcp_config.json 一处，只能用 mcp_config 工具管理；不要用 mcporter，也不要改其他客户端的配置文件。',
  })
}

/** `name` + a single unnamed server object → a named import. */
function withServerName(config: unknown, name: string): unknown {
  if (!name) return config
  let value = config
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return config
    }
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('mcpServers' in value) &&
    !('servers' in value) &&
    !('name' in value) &&
    ['command', 'url', 'baseUrl', 'serverUrl'].some((key) => key in value)
  )
    return { ...(value as Record<string, unknown>), name }
  return config
}

async function storedServer(root: string, name: string): Promise<ServerConfig> {
  const server = (await loadMcpConfig(root, {})).servers[name]
  if (server === undefined)
    throw new ToolError(`MCP server not configured: ${name}`, 'NOT_FOUND')
  return server
}

function targetOf(server: ServerConfig): string {
  if (server.transport === 'stdio')
    return [
      server.command ?? '',
      server.args.length ? `(+${server.args.length} args)` : '',
    ]
      .filter(Boolean)
      .join(' ')
  return server.url ? maskSecretUrl(server.url) : '(no url)'
}

async function formatList(
  deps: McpConfigToolDeps,
  displayPath: string,
): Promise<string> {
  const config = await loadMcpConfig(deps.stateRoot, {})
  const servers = Object.values(config.servers)
  if (!servers.length)
    return `No MCP servers configured in ${displayPath}. Use action=add with the server JSON.`
  const status = new Map(
    deps.status().servers.map((server) => [server.serverName, server]),
  )
  const lines = servers
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((server) => {
      const live = status.get(server.name)
      const state = !server.enabled ? 'disabled' : (live?.state ?? 'stopped')
      const tools = live?.toolCount ?? 0
      const keys = [
        ...Object.keys(server.env).map((key) => `env ${key}`),
        ...Object.keys(server.headers).map((key) => `header ${key}`),
      ]
      const error = live?.lastError ? ` · error: ${live.lastError.message}` : ''
      return `- ${server.name} [${server.transport}] ${state} · ${tools} tools · ${targetOf(server)}${keys.length ? ` · ${keys.join(', ')}` : ''}${error}`
    })
  return `MCP servers in ${displayPath} (${servers.length}):\n${lines.join('\n')}`
}

function formatImport(plan: McpImportPlan, tail: string): string {
  const lines = plan.servers.map(
    (server) =>
      `- ${server.name} [${server.transport}] ${server.action === 'add' ? 'added' : server.action === 'update' ? 'updated' : 'skipped'} · ${server.target}`,
  )
  const warnings = plan.warnings.length
    ? `\nWarnings:\n${plan.warnings.map((warning) => `- ${warning}`).join('\n')}`
    : ''
  return `${lines.length ? `${lines.join('\n')}\n` : ''}${tail}${warnings}`
}
