/**
 * Test fixtures: a local MCP server over Streamable HTTP (stateless) or the
 * legacy HTTP+SSE transport, exposing one `echo` tool. Used by the transport
 * and `mcp_config` tool suites; not part of the runtime.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export interface McpHttpFixture {
  /** Endpoint to configure (`/mcp` for http, `/sse` for sse-only). */
  readonly url: string
  /** Request log: `METHOD path`. */
  readonly requests: string[]
  close(): Promise<void>
}

export interface McpHttpFixtureOptions {
  /** `http` serves Streamable HTTP at /mcp; `sse-only` serves legacy SSE at /sse. */
  mode?: 'http' | 'sse-only'
  /** Reject requests lacking this header value (401). */
  requireHeader?: { name: string; value: string }
  toolName?: string
}

function echoServer(toolName: string): McpServer {
  const server = new McpServer({ name: 'emperor-test', version: '1.0.0' })
  server.registerTool(
    toolName,
    {
      description: 'Echo the given text back.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
  )
  return server
}

export async function startMcpHttpFixture(
  options: McpHttpFixtureOptions = {},
): Promise<McpHttpFixture> {
  const mode = options.mode ?? 'http'
  const toolName = options.toolName ?? 'echo'
  const requests: string[] = []
  const sseSessions = new Map<string, SSEServerTransport>()
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(`${req.method} ${path}`)
    const required = options.requireHeader
    if (
      required &&
      req.headers[required.name.toLowerCase()] !== required.value
    ) {
      res.writeHead(401).end('unauthorized')
      return
    }
    if (mode === 'http' && path === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const server = echoServer(toolName)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    if (mode === 'sse-only' && path === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res)
      sseSessions.set(transport.sessionId, transport)
      res.on('close', () => sseSessions.delete(transport.sessionId))
      await echoServer(toolName).connect(transport)
      return
    }
    if (mode === 'sse-only' && path === '/messages' && req.method === 'POST') {
      const sessionId =
        new URL(req.url ?? '/', 'http://localhost').searchParams.get(
          'sessionId',
        ) ?? ''
      const transport = sseSessions.get(sessionId)
      if (!transport) {
        res.writeHead(404).end()
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }
    res.writeHead(mode === 'sse-only' ? 405 : 404).end()
  }
  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${mode === 'http' ? '/mcp' : '/sse'}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
