import type { CoreOperationResult } from '@emperor/core/api'
import { invokeCore } from './backend'

/** Pasted MCP JSON: text (JSON/JSONC/fragment) or an already-parsed object. */
export type McpImportRaw = string | Record<string, unknown>

export interface McpImportOptions {
  /** Replace existing servers: `true` for every conflict, or only these names. */
  overwrite?: boolean | string[]
}

/** Masked editor view of mcp_config.json (secrets as `[REDACTED]`). */
export type McpConfigView = CoreOperationResult<'mcp.getConfig'>
export type McpStatusView = CoreOperationResult<'mcp.status'>
export type McpImportResult = CoreOperationResult<'mcp.importServers'>
export type McpImportServerPreview = McpImportResult['servers'][number]
export type McpServerEnabledResult = CoreOperationResult<'mcp.setServerEnabled'>
export type McpServerRemoveResult = CoreOperationResult<'mcp.removeServer'>

export async function getMcpConfig(): Promise<McpConfigView> {
  return invokeCore('mcp.getConfig')
}

export async function getMcpStatus(): Promise<McpStatusView> {
  return invokeCore('mcp.status')
}

/** Detect the pasted format and preview adds/updates/conflicts without writing. */
export async function previewMcpImport(
  raw: McpImportRaw,
  options: McpImportOptions = {},
): Promise<McpImportResult> {
  return invokeCore('mcp.importServers', { raw, ...options, dryRun: true })
}

/** Merge pasted servers into Emperor's mcp_config.json and reload MCP. */
export async function importMcpServers(
  raw: McpImportRaw,
  options: McpImportOptions = {},
): Promise<McpImportResult> {
  return invokeCore('mcp.importServers', { raw, ...options })
}

export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
): Promise<McpServerEnabledResult> {
  return invokeCore('mcp.setServerEnabled', { name, enabled })
}

export async function removeMcpServer(
  name: string,
): Promise<McpServerRemoveResult> {
  return invokeCore('mcp.removeServer', { name })
}
