import { randomUUID } from 'node:crypto'
import {
  coreOperationKeys,
  invokeCoreOperation,
  type CoreApi,
  type CoreIpcErrorEnvelope,
  type CoreOperationKey,
  type CoreOperationResult,
} from '@emperor/core'
import { channelForCoreOperation } from '../shared/ipc-contract'

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void
}

export type CoreApiLike = CoreApi

export type IpcAuthorizer = (event: unknown) => void

export function registerCoreIpc(
  ipcMain: IpcMainLike,
  coreApi: CoreApiLike,
  operationKeys: readonly CoreOperationKey[] = coreOperationKeys(),
  opts: { authorize?: IpcAuthorizer } = {},
): void {
  for (const key of [...operationKeys].sort()) {
    ipcMain.handle(channelForCoreOperation(key), async (event, ...args) => {
      try {
        opts.authorize?.(event)
        return await invokeOperation(coreApi, key, args)
      } catch (error) {
        return safeIpcError(error, key)
      }
    })
  }
}

export async function invokeOperation(
  coreApi: CoreApiLike,
  operationKey: CoreOperationKey,
  args: unknown[],
): Promise<CoreOperationResult<typeof operationKey>> {
  return invokeCoreOperation(coreApi, operationKey, args)
}

function safeIpcError(
  error: unknown,
  operationKey: string,
): CoreIpcErrorEnvelope {
  try {
    const interruption = benignTurnInterruption(error)
    if (interruption) return { ok: false, error: interruption }

    const domain = safeDomainError(error)
    if (domain) return { ok: false, error: domain }
  } catch {
    // Error normalization is a trust boundary and must never reject the IPC call.
  }

  const errorId = `ipc_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  if (process.env.NODE_ENV !== 'production') {
    try {
      console.error(`[core-ipc] ${operationKey} failed (${errorId})`, error)
    } catch {
      // Hostile Proxy/getter values can also fail during console inspection.
    }
  }
  return {
    ok: false,
    error: {
      message: 'Internal error',
      errorId,
    },
  }
}

function safeDomainError(
  error: unknown,
): { message: string; code: string; action?: string } | null {
  try {
    if (!error || typeof error !== 'object') return null
    const toSafe = (error as { toSafe?: unknown }).toSafe
    if (typeof toSafe !== 'function') return null
    const payload = toSafe.call(error)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return null
    const record = payload as Record<string, unknown>
    const message =
      typeof record.message === 'string' && record.message ? record.message : ''
    const code =
      typeof record.code === 'string' && record.code ? record.code : ''
    if (!message || !code) return null
    return {
      message,
      code,
      ...(typeof record.action === 'string' && record.action
        ? { action: record.action }
        : {}),
    }
  } catch {
    return null
  }
}

function benignTurnInterruption(
  error: unknown,
): { message: string; code: string } | null {
  let name = ''
  try {
    name =
      error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name || '')
        : ''
  } catch {
    return null
  }
  if (name === 'TurnPaused')
    return { message: 'Turn paused', code: 'turn_paused' }
  if (name === 'CancelledTaskError')
    return { message: 'Task cancelled', code: 'cancelled' }
  if (name === 'TurnBusyError')
    return {
      message: 'Another agent turn is already running',
      code: 'turn_busy',
    }
  return null
}
