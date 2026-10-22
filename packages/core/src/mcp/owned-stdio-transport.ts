import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  deserializeMessage,
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

/** One message's ceiling; a longer line is dropped, the server lives on. */
export const MCP_MESSAGE_LIMIT_BYTES = 16 * 1_024 * 1_024
/** stderr kept for the diagnostics page (the newest bytes). */
export const MCP_STDERR_RING_BYTES = 256 * 1_024
/** stdout read per second before reading pauses until the next second. */
const MCP_STDOUT_RATE_BYTES = 64 * 1_024 * 1_024

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
 *
 * The child is a long-lived stream (KRN-04): no cumulative output quota.
 * stdout is framed by line with a per-message ceiling and a read-rate
 * limit (reading pauses, the process is never killed for volume); stderr
 * goes to a bounded ring that never blocks the server.
 */
export class OwnedStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private chunks: Buffer[] = []
  private pendingBytes = 0
  /** Inside an oversized line: drop bytes until its newline. */
  private discarding = false
  private stderrRing: Buffer[] = []
  private stderrBytes = 0
  private windowStart = 0
  private windowBytes = 0
  private handle: OwnedProcessHandle | null = null

  constructor(private readonly opts: OwnedStdioClientTransportOptions) {}

  /** The last `lines` lines the server wrote to stderr (diagnostics). */
  stderrTail(lines = 200): string {
    const text = Buffer.concat(this.stderrRing).toString('utf8')
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
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
        stream: 'long-lived',
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
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.limitRate(handle, buffer.length)
      this.receive(buffer)
    })
    handle.stdout.on('error', (error) => this.onerror?.(error))
    handle.stdin.on('error', (error) => this.onerror?.(error))
    handle.stderr.on('data', (chunk: Buffer | string) =>
      this.keepStderr(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    )
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
    this.chunks = []
    this.pendingBytes = 0
    this.discarding = false
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

  /** Frame stdout by newline; an oversized line is dropped, not fatal. */
  private receive(chunk: Buffer): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline < 0 ? chunk.length : newline
      if (!this.discarding) {
        const part = chunk.subarray(start, end)
        if (this.pendingBytes + part.length > MCP_MESSAGE_LIMIT_BYTES) {
          this.chunks = []
          this.pendingBytes = 0
          this.discarding = true
          this.onerror?.(
            new MCPConnectionError(
              'mcp_protocol_error',
              `MCP server '${this.opts.serverName}' sent a message too large (over 16 MiB); it was dropped`,
            ),
          )
        } else {
          this.chunks.push(part)
          this.pendingBytes += part.length
        }
      }
      if (newline < 0) return
      if (this.discarding) this.discarding = false
      else this.emitLine()
      start = newline + 1
    }
  }

  private emitLine(): void {
    const line = Buffer.concat(this.chunks).toString('utf8').replace(/\r$/, '')
    this.chunks = []
    this.pendingBytes = 0
    if (!line) return
    try {
      this.onmessage?.(deserializeMessage(line))
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Past the read rate, pause stdout until the next second. */
  private limitRate(handle: OwnedProcessHandle, bytes: number): void {
    const now = Date.now()
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.windowBytes = 0
    }
    this.windowBytes += bytes
    if (this.windowBytes <= MCP_STDOUT_RATE_BYTES) return
    handle.stdout.pause()
    const timer = setTimeout(
      () => {
        if (this.handle === handle) handle.stdout.resume()
      },
      1000 - (now - this.windowStart),
    )
    timer.unref()
  }

  private keepStderr(chunk: Buffer): void {
    this.stderrRing.push(chunk)
    this.stderrBytes += chunk.length
    while (
      this.stderrBytes > MCP_STDERR_RING_BYTES &&
      this.stderrRing.length > 1
    ) {
      this.stderrBytes -= this.stderrRing.shift()!.length
    }
  }
}
