import { randomUUID } from 'node:crypto'
import { channelForCoreOperation } from '../shared/ipc-contract'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export type CoreApiLike = Record<string, unknown>

export function registerCoreIpc(ipcMain: IpcMainLike, coreApi: CoreApiLike, operationKeys: string[]): void {
  for (const key of [...operationKeys].sort()) {
    ipcMain.handle(channelForCoreOperation(key), async (_event, ...args) => {
      try {
        return await invokeOperation(coreApi, key, args)
      } catch (error) {
        return safeIpcError(error, key)
      }
    })
  }
}

export async function invokeOperation(coreApi: CoreApiLike, operationKey: string, args: unknown[]): Promise<unknown> {
  const { fn, receiver } = resolveOperation(coreApi, operationKey)
  if (typeof fn !== 'function') throw new Error(`CoreApi operation not found: ${operationKey}`)
  return await Reflect.apply(fn, receiver, args)
}

function resolveOperation(coreApi: CoreApiLike, operationKey: string): { fn: unknown; receiver: unknown } {
  let current: unknown = coreApi
  let receiver: unknown = coreApi
  for (const part of operationKey.split('.')) {
    receiver = current
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
  }
  return { fn: current, receiver }
}

function safeIpcError(error: unknown, operationKey: string): Record<string, unknown> {
  const errorId = `ipc_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[core-ipc] ${operationKey} failed (${errorId})`, error)
  }
  return {
    ok: false,
    error: {
      message: 'Internal error',
      errorId,
    },
  }
}
