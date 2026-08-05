import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandInvocationResult } from './types'

interface StoredInvocation {
  sessionId: string
  invocationId: string
  commandId?: string
  invocationSource?: string
  digest: string
  result: CommandInvocationResult
  updatedAt: string
}

interface StorePayload {
  version: 1
  invocations: StoredInvocation[]
}

export class CommandInvocationStoreCorruptError extends Error {
  readonly code = 'command_invocation_store_corrupt'

  constructor() {
    super('命令调用账本损坏；为避免重复执行，当前命令已安全拒绝。')
    this.name = 'CommandInvocationStoreCorruptError'
  }
}

export class CommandInvocationStore {
  readonly path: string

  constructor(stateRoot: string) {
    this.path = join(stateRoot, 'control', 'command-invocations.json')
  }

  get(sessionId: string, invocationId: string): StoredInvocation | null {
    return (
      this.load().invocations.find(
        (item) =>
          item.sessionId === sessionId && item.invocationId === invocationId,
      ) ?? null
    )
  }

  put(
    sessionId: string,
    invocationId: string,
    digest: string,
    result: CommandInvocationResult,
    metadata: { commandId?: string; invocationSource?: string } = {},
  ): void {
    const payload = this.load()
    const next: StoredInvocation = {
      sessionId,
      invocationId,
      ...(metadata.commandId ? { commandId: metadata.commandId } : {}),
      ...(metadata.invocationSource
        ? { invocationSource: metadata.invocationSource }
        : {}),
      digest,
      result,
      updatedAt: new Date().toISOString(),
    }
    const index = payload.invocations.findIndex(
      (item) =>
        item.sessionId === sessionId && item.invocationId === invocationId,
    )
    if (index < 0) payload.invocations.push(next)
    else payload.invocations[index] = next
    payload.invocations = payload.invocations.slice(-512)
    this.save(payload)
  }

  private load(): StorePayload {
    if (!existsSync(this.path)) return { version: 1, invocations: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StorePayload
      if (parsed.version !== 1 || !Array.isArray(parsed.invocations))
        throw new CommandInvocationStoreCorruptError()
      return parsed
    } catch (error) {
      if (error instanceof CommandInvocationStoreCorruptError) throw error
      throw new CommandInvocationStoreCorruptError()
    }
  }

  private save(payload: StorePayload): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }
}
