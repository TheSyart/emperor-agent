import { PassThrough, type Stream } from 'node:stream'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  type OwnedProcessHandle,
  OwnedProcessRuntime,
} from '../processes/runtime'

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
}

/** MCP stdio transport whose child is born inside the shared process runtime. */
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
    const handle = await this.opts.runtime.spawn({
      executable: this.opts.command,
      args: [...(this.opts.args ?? [])],
      cwd: this.opts.cwd ?? this.opts.workspaceRoot,
      env: { ...(this.opts.env ?? {}) },
      maxOutputBytes: MCP_STDIO_OUTPUT_QUOTA_BYTES,
      outputPolicy: 'terminate',
      outputQuotaScope: 'combined',
      owner: {
        kind: 'mcp',
        id: this.opts.serverName,
        sessionId: this.opts.ownerSessionId ?? null,
      },
      containment: {
        mode: 'preferred',
        workspaceRoot: this.opts.workspaceRoot,
        stateRoot: this.opts.stateRoot,
        tempRoot: this.opts.workspaceRoot,
        readOnlyRoots: [],
        network: 'allow',
      },
    })
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
