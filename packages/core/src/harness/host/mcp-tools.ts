/**
 * MCP tools on the new kernel: each connected server tool becomes one
 * ToolDefinition named `mcp_<server>_<tool>`. Arguments are forwarded as the
 * server declared them (the server validates); results are treated as
 * untrusted external content, as before.
 */

import type { MCPClient } from '../../mcp/client'
import type { MCPToolAdapter } from '../../mcp/adapter'
import { ToolArgsError, type ToolDefinition } from '../tools/definition'
import type { ToolRegistry } from '../tools/registry'

export function mcpToolDefinition(
  adapter: MCPToolAdapter,
): ToolDefinition<Record<string, unknown>> {
  const parameters = (
    typeof adapter.parameters === 'object' && adapter.parameters !== null
      ? adapter.parameters
      : { type: 'object', properties: {} }
  ) as Record<string, unknown>
  return {
    name: adapter.name,
    description: adapter.description,
    parameters,
    parse(raw: unknown): Record<string, unknown> {
      if (raw === undefined || raw === null) return {}
      if (typeof raw !== 'object' || Array.isArray(raw))
        throw new ToolArgsError(adapter.name, 'arguments must be a JSON object')
      return raw as Record<string, unknown>
    },
    isConcurrencySafe: () => adapter.readOnly && !adapter.exclusive,
    async execute(args, context) {
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
    },
  }
}

/** Keep the registry's MCP tools in sync with the client's connected tools. */
export class McpToolBridge {
  private disposers = new Map<string, () => void>()

  constructor(
    private readonly client: MCPClient,
    private readonly tools: ToolRegistry,
  ) {}

  sync(): void {
    const current = new Map(
      this.client.getTools().map((tool) => [tool.name, tool]),
    )
    for (const [name, dispose] of [...this.disposers]) {
      if (!current.has(name)) {
        dispose()
        this.disposers.delete(name)
      }
    }
    for (const [name, adapter] of current) {
      if (this.disposers.has(name)) {
        this.disposers.get(name)?.()
      }
      this.disposers.set(name, this.tools.register(mcpToolDefinition(adapter)))
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }
}
