// Electron desktop talks to CoreApi over preload IPC. Browser-only tests inject
// this same bridge surface; the product no longer supports HTTP/WS fallback.

import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core'

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE =
  'Core IPC bridge is unavailable; use the Electron desktop window.'

interface EmperorBridge {
  selectDirectory?: () => Promise<string | null>
  openPath?: (
    target: string,
  ) => Promise<{ ok?: boolean; error?: string } | void>
  invokeCore?: <Key extends CoreOperationKey>(
    operationKey: Key,
    ...args: CoreOperationArgs<Key>
  ) => Promise<CoreOperationResult<Key> | CoreIpcErrorEnvelope>
  onCoreEvent?: (listener: (event: unknown) => void) => () => void
}

function bridge(): EmperorBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: EmperorBridge } })
    .window?.emperor
}

export async function selectDirectory(): Promise<string | null> {
  const picker = bridge()?.selectDirectory
  return typeof picker === 'function' ? picker() : null
}

export async function openPath(target: string): Promise<void> {
  const opener = bridge()?.openPath
  if (typeof opener !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(target)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Failed to open path',
    )
  }
}

export async function invokeCore<Key extends CoreOperationKey>(
  operationKey: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  const invoke = bridge()?.invokeCore
  if (typeof invoke !== 'function')
    throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await invoke(operationKey, ...args)
  if (isCoreIpcErrorEnvelope(result)) {
    const safeError = safeCoreIpcError(result)
    const error = new Error(safeError.message) as Error & {
      errorId?: string
      code?: string
      action?: string
    }
    if (safeError.errorId) error.errorId = safeError.errorId
    if (safeError.code) error.code = safeError.code
    if (safeError.action) error.action = safeError.action
    throw error
  }
  return result
}

export function hasCoreBridge(): boolean {
  return typeof bridge()?.invokeCore === 'function'
}

export function onCoreEvent(listener: (event: unknown) => void): () => void {
  const subscribe = bridge()?.onCoreEvent
  if (typeof subscribe !== 'function') return () => {}
  return subscribe(listener)
}

function isCoreIpcErrorEnvelope(value: unknown): value is CoreIpcErrorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return (
    payload.ok === false &&
    Boolean(
      payload.error &&
      typeof payload.error === 'object' &&
      !Array.isArray(payload.error),
    )
  )
}

function safeCoreIpcError(value: CoreIpcErrorEnvelope): {
  message: string
  errorId?: string
  code?: string
  action?: string
} {
  const error = value.error
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : 'Internal error'
  return {
    message,
    errorId: typeof error.errorId === 'string' ? error.errorId : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    action: typeof error.action === 'string' ? error.action : undefined,
  }
}
