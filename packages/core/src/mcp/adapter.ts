import type { ExecutionEnvironment } from '../environment/snapshot'
import type { MCPConnection } from './connection'
import {
  createBoundedExternalContentEnvelope,
  externalContentMetadata,
  renderExternalContentEnvelope,
} from '../external-content'

/** Declared capability of one MCP tool (from config overrides or defaults). */
export interface MCPToolProvenance {
  kind: 'mcp_declaration'
  serverName: string
  toolName: string
  transport: string
  readOnlySource: 'tool_override' | 'config_default' | 'fallback_write'
  exclusiveSource: 'tool_override' | 'config_default' | 'fallback_serialized'
  generation: number | null
  clientId: string | null
}

export interface MCPToolCallContext {
  parentCallId?: string | null
  signal?: AbortSignal | null
  executionEnvironment?: ExecutionEnvironment | null
}

export interface MCPToolResult {
  modelContent: string
  displaySummary: string
  rawContent: string
  metadata: Record<string, unknown>
  isError: boolean
}

/** Default bound of the external-content envelope handed to the model. */
export const MCP_DEFAULT_MAX_RESULT_CHARS = 12_000

/** One connected MCP server tool, exposed to the kernel as `mcp_<server>_<tool>`. */
export class MCPToolAdapter {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly readOnly: boolean
  readonly exclusive: boolean
  readonly maxResultChars: number
  readonly capabilityProvenance: MCPToolProvenance
  readonly evidencePolicy = 'context_only' as const
  readonly externalContent = true
  private readonly serverName: string
  private readonly toolName: string
  readonly mcpServerName: string
  readonly mcpToolName: string
  private readonly connection: MCPConnection
  private readonly callTimeoutMs: number | null

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
    this.serverName = opts.serverName
    this.mcpServerName = opts.serverName
    this.name = `mcp_${opts.serverName}_${opts.toolName}`
    this.description = `[MCP:${opts.serverName}] ${opts.description}`
    this.parameters = opts.parametersSchema
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
    this.maxResultChars =
      opts.maxResultChars && opts.maxResultChars > 0
        ? opts.maxResultChars
        : MCP_DEFAULT_MAX_RESULT_CHARS
  }

  /** Capability summary for diagnostics and the MCP snapshot. */
  capabilityDescriptor(): {
    version: 1
    toolName: string
    readMode: 'static_read_only' | 'mutating'
    mutationScope: 'none' | 'external'
    evidencePolicy: 'context_only'
    externalContent: true
    provenance: MCPToolProvenance
  } {
    return {
      version: 1,
      toolName: this.name,
      readMode: this.readOnly ? 'static_read_only' : 'mutating',
      mutationScope: this.readOnly ? 'none' : 'external',
      evidencePolicy: this.evidencePolicy,
      externalContent: this.externalContent,
      provenance: structuredClone(this.capabilityProvenance),
    }
  }

  async execute(
    args: Record<string, unknown>,
    context?: MCPToolCallContext,
  ): Promise<MCPToolResult> {
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
        transport: provenance.transport,
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
      isError: result.isError === true,
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
