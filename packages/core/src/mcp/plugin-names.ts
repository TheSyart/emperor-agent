/**
 * Tool names of MCP servers: `mcp_<server>_<tool>` in at most 64 characters
 * of `[A-Za-z0-9_-]` (plugin contract §3.2; the user's own servers since
 * KRN-04). The server part shrinks first, then the tool part; each cut
 * appends a hash of the original, so distinct names stay distinct and the
 * result never changes between runs.
 */

import { createHash } from 'node:crypto'

const TOOL_NAME_LIMIT = 64

export function pluginMcpToolName(
  key: string,
  pluginId: string,
  serverName: string,
  toolName: string,
): string {
  return fittedMcpToolName(key, `${pluginId}\0${serverName}`, toolName)
}

/**
 * A tool of a server in mcp_config.json: the server name is cleaned like a
 * tool name, so `my.server` gives `mcp_my_server_<tool>`. Names that were
 * already valid stay as they were.
 */
export function userMcpToolName(serverName: string, toolName: string): string {
  return fittedMcpToolName(sanitizeMcpName(serverName), serverName, toolName)
}

/** `name` made distinct from names already taken, by a hash of `seed`. */
export function distinctMcpToolName(name: string, seed: string): string {
  return `${name.slice(0, TOOL_NAME_LIMIT - 7)}_${shortHash(seed)}`
}

function fittedMcpToolName(
  server: string,
  serverSeed: string,
  toolName: string,
): string {
  let serverPart = server
  let toolPart = sanitizeMcpName(toolName)
  const fits = () => 5 + serverPart.length + toolPart.length <= TOOL_NAME_LIMIT
  if (fits()) return `mcp_${serverPart}_${toolPart}`
  const keyBudget = Math.max(15, TOOL_NAME_LIMIT - 5 - toolPart.length)
  if (serverPart.length > keyBudget)
    serverPart = `${serverPart.slice(0, keyBudget - 7)}_${shortHash(serverSeed)}`
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
