/** Typed MCP connection failures (shared by the connection and its transports). */

import { EmperorError } from '../errors'

export type MCPConnectionErrorCode =
  | 'mcp_aborted'
  | 'mcp_auth_failed'
  | 'mcp_config_invalid'
  | 'mcp_connection_failed'
  | 'mcp_protocol_error'
  | 'mcp_restart_exhausted'
  | 'mcp_transport_timeout'
  | 'mcp_unavailable'
  /** The process sandbox refused to start the server (SEC-08). */
  | 'mcp_sandbox_refused'
  /** The sandbox is unavailable and the user has not answered yet (SEC-08). */
  | 'mcp_sandbox_consent_required'

export class MCPConnectionError extends EmperorError {
  constructor(
    code: MCPConnectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, code, options)
  }
}
