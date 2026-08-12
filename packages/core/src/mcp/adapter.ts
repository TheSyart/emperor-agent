import { Tool, type ToolExecutionContext, type ToolResult } from '../tools/base'
import type { ToolParamsSchema } from '../tools/schema'
import type { MCPConnection } from './connection'
import {
  createBoundedExternalContentEnvelope,
  externalContentMetadata,
  renderExternalContentEnvelope,
} from '../external-content'

export class MCPToolAdapter extends Tool {
  override readonly name: string
  override readonly description: string
  override readonly parameters: ToolParamsSchema
  private readonly serverName: string
  private readonly toolName: string
  readonly mcpServerName: string
  readonly mcpToolName: string
  private readonly connection: MCPConnection
  private readonly callTimeoutMs: number | null
  override evidencePolicy = 'context_only' as const
  override externalContent = true

  constructor(opts: {
    serverName: string
    toolName: string
    description: string
    parametersSchema: Record<string, unknown>
    connection: MCPConnection
    readOnly?: boolean
    exclusive?: boolean
    maxResultChars?: number | null
    callTimeoutMs?: number | null
    transport?: string
    readOnlySource?: 'tool_override' | 'config_default' | 'fallback_write'
    exclusiveSource?: 'tool_override' | 'config_default' | 'fallback_serialized'
    generation?: number | null
    clientId?: string | null
  }) {
    super()
    this.serverName = opts.serverName
    this.mcpServerName = opts.serverName
    this.name = `mcp_${opts.serverName}_${opts.toolName}`
    this.description = `[MCP:${opts.serverName}] ${opts.description}`
    this.parameters = opts.parametersSchema as unknown as ToolParamsSchema
    this.connection = opts.connection
    this.toolName = opts.toolName
    this.mcpToolName = opts.toolName
    this.callTimeoutMs = opts.callTimeoutMs ?? null
    this.readOnly = opts.readOnly ?? false
    this.exclusive = opts.exclusive ?? false
    this.capabilityProvenance = {
      kind: 'mcp_declaration',
      serverName: opts.serverName,
      toolName: opts.toolName,
      transport: String(opts.transport ?? 'unknown'),
      readOnlySource:
        opts.readOnlySource ??
        (opts.readOnly === undefined ? 'fallback_write' : 'tool_override'),
      exclusiveSource:
        opts.exclusiveSource ??
        (opts.exclusive === undefined
          ? 'fallback_serialized'
          : 'tool_override'),
      generation: opts.generation ?? null,
      clientId: opts.clientId ?? null,
    }
    if (opts.maxResultChars && opts.maxResultChars > 0)
      this.maxResultChars = opts.maxResultChars
  }

  override async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const result = await this.connection.callToolRequest(this.toolName, args, {
      requestId: mcpRequestId(context?.parentCallId),
      signal: context?.signal ?? null,
      timeoutMs: this.callTimeoutMs,
      executionEnvironment: context?.executionEnvironment ?? null,
    })
    const provenance = this.capabilityProvenance
    const envelope = createBoundedExternalContentEnvelope({
      source: {
        kind: 'mcp',
        locator: `mcp://${this.serverName}/${this.toolName}`,
        transport:
          provenance.kind === 'mcp_declaration'
            ? provenance.transport
            : 'unknown',
        provenance: {
          server: this.serverName,
          tool: this.toolName,
          generation: result.generation ?? null,
          client_id: result.clientId ?? null,
        },
      },
      content: result.content,
      maxBytes: this.maxResultChars,
    })
    return {
      modelContent: renderExternalContentEnvelope(envelope),
      displaySummary: result.content.slice(0, 120),
      rawContent: result.content,
      artifacts: [],
      metadata: {
        tool: this.name,
        mcp: true,
        untrusted: true,
        server: this.serverName,
        mcp_tool: this.toolName,
        external_content: externalContentMetadata(envelope),
        ...(result.requestId ? { mcp_request_id: result.requestId } : {}),
        ...(result.generation ? { mcp_generation: result.generation } : {}),
        ...(result.clientId ? { mcp_client_id: result.clientId } : {}),
      },
      isError: result.isError,
    }
  }
}

function mcpRequestId(toolCallId: string | null | undefined): string | null {
  const cleaned = String(toolCallId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 140)
  return cleaned ? `mcp_${cleaned}` : null
}
