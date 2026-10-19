/**
 * MCP tools on the new kernel: each connected server tool becomes one
 * ToolDefinition named `mcp_<server>_<tool>`. Arguments are forwarded as the
 * server declared them (the server validates); results are treated as
 * untrusted external content, as before.
 *
 * Tools come from two places (KRN-01): the global servers (the user's
 * `mcp_config.json` and user-wide plugins) and each project's instance
 * (project-scoped plugins). A session sees the global tools plus its own
 * project's; one name may exist in several projects, so a name is
 * registered once and each call goes to the server of the caller's project.
 */

import type { MCPToolAdapter } from '../../mcp/adapter'
import type { Agent } from '../agent/agent'
import {
  ToolArgsError,
  ToolError,
  type ToolDefinition,
} from '../tools/definition'
import type { ToolSchema } from '../../llm/types'
import type { ToolRegistry } from '../tools/registry'

export function mcpToolDefinition(
  adapter: MCPToolAdapter,
): ToolDefinition<Record<string, unknown>> {
  return {
    name: adapter.name,
    description: adapter.description,
    parameters: adapterParameters(adapter),
    parse: (raw) => parseArguments(adapter.name, raw),
    isConcurrencySafe: () => adapter.readOnly && !adapter.exclusive,
    execute: (args, context) => runAdapter(adapter, args, context),
  }
}

function adapterParameters(adapter: MCPToolAdapter): Record<string, unknown> {
  return (
    typeof adapter.parameters === 'object' && adapter.parameters !== null
      ? adapter.parameters
      : { type: 'object', properties: {} }
  ) as Record<string, unknown>
}

function parseArguments(name: string, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolArgsError(name, 'arguments must be a JSON object')
  return raw as Record<string, unknown>
}

async function runAdapter(
  adapter: MCPToolAdapter,
  args: Record<string, unknown>,
  context: { callId: string; signal: AbortSignal },
) {
  const result = await adapter.execute(args, {
    parentCallId: context.callId,
    signal: context.signal,
  } as never)
  return {
    content: result.modelContent,
    isError: result.isError === true,
    meta: {
      mcp: true,
      server: adapter.mcpServerName,
      tool: adapter.mcpToolName,
      summary: result.displaySummary ?? '',
    },
  }
}

/** Where the bridge reads tools from. */
export interface McpToolSources {
  /** Tools of the global servers. */
  global(): MCPToolAdapter[]
  /** Projects with a live instance. */
  projects(): string[]
  /** Tools of one project's instance. */
  project(projectRoot: string): MCPToolAdapter[]
  /**
   * Plugin ids whose global tools a project replaces with its own copy of
   * the plugin (a project-scoped install wins over the user-wide one).
   */
  hiddenInProject?(projectRoot: string): ReadonlySet<string>
}

interface Entry {
  global?: MCPToolAdapter
  readonly projects: Map<string, MCPToolAdapter>
}

/** Keep the registry's MCP tools in sync with the global and project servers. */
export class McpToolBridge {
  private entries = new Map<string, Entry>()
  private readonly disposers = new Map<string, () => void>()

  constructor(
    private readonly sources: McpToolSources,
    private readonly tools: ToolRegistry,
    /** The project an agent works in (its root session's); null for Chat. */
    private readonly projectOf: (agent: Agent | undefined) => string | null,
  ) {}

  sync(): void {
    const next = new Map<string, Entry>()
    const entry = (name: string): Entry => {
      let found = next.get(name)
      if (found === undefined) {
        found = { projects: new Map() }
        next.set(name, found)
      }
      return found
    }
    for (const adapter of this.sources.global())
      entry(adapter.name).global = adapter
    for (const projectRoot of this.sources.projects())
      for (const adapter of this.sources.project(projectRoot))
        entry(adapter.name).projects.set(projectRoot, adapter)
    this.entries = next
    for (const [name, dispose] of [...this.disposers]) {
      dispose()
      this.disposers.delete(name)
    }
    for (const name of next.keys())
      this.disposers.set(
        name,
        this.tools.register(this.definition(name), {
          visible: (agent) =>
            this.adapterFor(name, this.projectOf(agent)) !== undefined,
        }),
      )
  }

  /** The server tool a caller in `projectRoot` (null: Chat) reaches by this name. */
  adapterFor(
    name: string,
    projectRoot: string | null,
  ): MCPToolAdapter | undefined {
    const entry = this.entries.get(name)
    if (entry === undefined) return undefined
    if (projectRoot !== null) {
      const own = entry.projects.get(projectRoot)
      if (own !== undefined) return own
    }
    const global = entry.global
    if (global === undefined) return undefined
    if (
      projectRoot !== null &&
      global.pluginId &&
      this.sources.hiddenInProject?.(projectRoot).has(global.pluginId)
    )
      return undefined
    return global
  }

  /** Every MCP tool name registered (any scope). */
  names(): string[] {
    return [...this.entries.keys()].sort()
  }

  /** The MCP tools a caller in `projectRoot` sees, sorted by name. */
  adaptersFor(projectRoot: string | null): MCPToolAdapter[] {
    return [...this.entries.keys()].sort().flatMap((name) => {
      const adapter = this.adapterFor(name, projectRoot)
      return adapter === undefined ? [] : [adapter]
    })
  }

  /** Model-facing schemas of those tools (for views without an agent). */
  schemasFor(projectRoot: string | null): ToolSchema[] {
    return this.adaptersFor(projectRoot).map((adapter) => ({
      name: adapter.name,
      description: adapter.description,
      parameters: adapterParameters(adapter),
    }))
  }

  /** Registered tool names that are not this bridge's MCP tools (plugin tools must not take them). */
  reservedNames(): ReadonlySet<string> {
    return new Set(
      this.tools.names().filter((name) => !this.disposers.has(name)),
    )
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
    this.entries.clear()
  }

  private definition(name: string): ToolDefinition<Record<string, unknown>> {
    const entry = this.entries.get(name)!
    const base = entry.global ?? [...entry.projects.values()][0]!
    const all = [
      ...(entry.global ? [entry.global] : []),
      ...entry.projects.values(),
    ]
    const forAgent = (agent: Agent | undefined) =>
      this.adapterFor(name, this.projectOf(agent))
    return {
      name,
      description: base.description,
      descriptionFor: (agent) => forAgent(agent)?.description,
      parameters: adapterParameters(base),
      parametersFor: (agent) => {
        const adapter = forAgent(agent)
        return adapter === undefined ? undefined : adapterParameters(adapter)
      },
      parse: (raw) => parseArguments(name, raw),
      // Parallel only when every server behind the name allows it.
      isConcurrencySafe: () =>
        all.every((adapter) => adapter.readOnly && !adapter.exclusive),
      execute: async (args, context) => {
        const adapter = forAgent(context.agent)
        if (adapter === undefined)
          throw new ToolError(
            `MCP tool ${name} is not available in this session`,
            'TOOL_UNAVAILABLE',
          )
        return await runAdapter(adapter, args, context)
      },
    }
  }
}
