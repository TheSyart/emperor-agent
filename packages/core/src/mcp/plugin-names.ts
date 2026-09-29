/**
 * Tool names of plugin MCP servers (plugin contract §3.2): `mcp_<key>_<tool>`
 * in at most 64 characters of `[A-Za-z0-9_-]`. The key shrinks first, then
 * the tool part; each cut appends a hash of the original, so distinct names
 * stay distinct and the result never changes between runs.
 */

import { createHash } from 'node:crypto'

const TOOL_NAME_LIMIT = 64

export function pluginMcpToolName(
  key: string,
  pluginId: string,
  serverName: string,
  toolName: string,
): string {
  let serverPart = key
  let toolPart = sanitizeMcpName(toolName)
  const fits = () => 5 + serverPart.length + toolPart.length <= TOOL_NAME_LIMIT
  if (fits()) return `mcp_${serverPart}_${toolPart}`
  const keyBudget = Math.max(15, TOOL_NAME_LIMIT - 5 - toolPart.length)
  if (serverPart.length > keyBudget)
    serverPart = `${serverPart.slice(0, keyBudget - 7)}_${shortHash(`${pluginId}\0${serverName}`)}`
  if (fits()) return `mcp_${serverPart}_${toolPart}`
  toolPart = `${toolPart.slice(0, TOOL_NAME_LIMIT - 5 - serverPart.length - 7)}_${shortHash(toolName)}`
  return `mcp_${serverPart}_${toolPart}`
}

/** Replace every character outside `[A-Za-z0-9_-]` with `_`. */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** First six hex characters of the SHA-256 of `value`. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6)
}
