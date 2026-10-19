import { PassThrough, type Stream } from 'node:stream'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  ContainmentRefusedError,
  type OwnedProcessHandle,
  OwnedProcessRuntime,
} from '../processes/runtime'
import type { UnsandboxedConsentPort } from '../sandbox/consent'
import { MCPConnectionError } from './errors'
import { mcpServerContainment, type McpServerSource } from './containment'

const MCP_STDIO_OUTPUT_QUOTA_BYTES = 8 * 1_024 * 1_024

export interface OwnedStdioClientTransportOptions {
  runtime: OwnedProcessRuntime
  serverName: string
  ownerSessionId?: string | null
  workspaceRoot: string
  stateRoot: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Folders inside the state root a plugin's server may use (its package and data). */
  stateGrants?: { read: string[]; write: string[] }
  /** Where the server comes from: a plugin's is never run unconfined. */
  source?: McpServerSource
  /** Asks the user before a user's server runs outside an unavailable sandbox. */
  consent?: UnsandboxedConsentPort | null
}

/**
 * MCP stdio transport whose child is born inside the shared process runtime
 * and its containment (SEC-08). A refused start fails `start()` with
 * `mcp_sandbox_refused` or, while a user's answer is pending,
 * `mcp_sandbox_consent_required`.
 */
export class OwnedStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly readBuffer = new ReadBuffer()
  private readonly stderrStream = new PassThrough()
  private handle: OwnedProcessHandle | null = null

  constructor(private readonly opts: OwnedStdioClientTransportOptions) {}

  get stderr(): Stream {
    return this.stderrStream
  }

  get pid(): number | null {
    return this.handle?.pid ?? null
  }

  async start(): Promise<void> {
    if (this.handle)
      throw new Error('Owned MCP stdio transport already started')
    const source = this.opts.source ?? 'plugin'
    const args = [...(this.opts.args ?? [])]
    const cwd = this.opts.cwd ?? this.opts.workspaceRoot
    const containment = mcpServerContainment({
      name: this.opts.serverName,
      source,
      stateRoot: this.opts.stateRoot,
      workspaceRoot: this.opts.workspaceRoot,
      cwd,
      command: this.opts.command,
      args,
      env: this.opts.env ?? {},
      grants: this.opts.stateGrants ?? null,
    })
    const consentPort = source === 'user' ? (this.opts.consent ?? null) : null
    let answer = null as string | null
    let handle: OwnedProcessHandle
    try {
      handle = await this.opts.runtime.spawn({
        executable: this.opts.command,
        args,
        cwd,
        env: { ...(this.opts.env ?? {}), ...containment.env },
        maxOutputBytes: MCP_STDIO_OUTPUT_QUOTA_BYTES,
        outputPolicy: 'terminate',
        outputQuotaScope: 'combined',
        owner: {
          kind: 'mcp',
          id: this.opts.serverName,
          sessionId: this.opts.ownerSessionId ?? null,
        },
        execution: { kind: 'sandbox', policy: containment.policy },
        consent: consentPort
          ? {
              decide: async (reason) => {
                answer = await consentPort.decide({
                  kind: 'mcp',
                  name: this.opts.serverName,
                  command: this.opts.command,
                  args,
                  cwd: this.opts.cwd ?? null,
                  reason,
                })
                return answer === 'allowed'
              },
            }
          : null,
      })
    } catch (error) {
      if (error instanceof ContainmentRefusedError) {
        const pending = answer === 'pending'
        throw new MCPConnectionError(
          pending ? 'mcp_sandbox_consent_required' : 'mcp_sandbox_refused',
          source === 'plugin'
            ? `${error.receipt.reason}；插件的 MCP 服务器不会在沙箱外启动`
            : pending
              ? `${error.receipt.reason.replace(/；用户没有同意在沙箱外运行$/, '')}；等待你在下一次对话中确认是否在沙箱外运行`
              : error.receipt.reason,
          { cause: error },
        )
      }
      throw error
    }
    this.handle = handle
    handle.stdout.on('data', (chunk: Buffer | string) => {
      this.readBuffer.append(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      )
      this.processReadBuffer()
    })
    handle.stdout.on('error', (error) => this.onerror?.(error))
    handle.stdin.on('error', (error) => this.onerror?.(error))
    handle.stderr.pipe(this.stderrStream, { end: false })
    handle.stderr.on('error', (error) => this.onerror?.(error))
    void handle.settled.then((result) => {
      if (this.handle === handle) this.handle = null
      if (result.status === 'spawn_error' && result.error)
        this.onerror?.(new Error(result.error))
      this.onclose?.()
    })
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.readBuffer.clear()
    if (!handle) return
    handle.cancel('mcp transport closed')
    await handle.settled
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.handle?.stdin
    if (!stdin) throw new Error('MCP stdio transport is not connected')
    const body = serializeMessage(message)
    if (stdin.write(body)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        stdin.off('drain', onDrain)
        stdin.off('error', onError)
      }
      stdin.once('drain', onDrain)
      stdin.once('error', onError)
    })
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
  }
}
