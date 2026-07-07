// Electron desktop talks to CoreApi over preload IPC. Browser-only tests inject
// this same bridge surface; the product no longer supports HTTP/WS fallback.

export const CORE_BRIDGE_UNAVAILABLE_MESSAGE = 'Core IPC bridge is unavailable; use the Electron desktop window.'

interface EmperorBridge {
  selectDirectory?: () => Promise<string | null>
  openPath?: (target: string) => Promise<{ ok?: boolean; error?: string } | void>
  invokeCore?: (operationKey: string, ...args: unknown[]) => Promise<unknown>
  onCoreEvent?: (listener: (event: unknown) => void) => () => void
}

function bridge(): EmperorBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: EmperorBridge } }).window?.emperor
}

export async function selectDirectory(): Promise<string | null> {
  const picker = bridge()?.selectDirectory
  return typeof picker === 'function' ? picker() : null
}

export async function openPath(target: string): Promise<void> {
  const opener = bridge()?.openPath
  if (typeof opener !== 'function') throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await opener(target)
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(typeof result.error === 'string' && result.error ? result.error : 'Failed to open path')
  }
}

export async function invokeCore(operationKey: string, ...args: unknown[]): Promise<unknown> {
  const invoke = bridge()?.invokeCore
  if (typeof invoke !== 'function') throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  const result = await invoke(operationKey, ...args)
  const safeError = safeCoreIpcError(result)
  if (safeError) {
    const error = new Error(safeError.message) as Error & { errorId?: string; code?: string }
    if (safeError.errorId) error.errorId = safeError.errorId
    if (safeError.code) error.code = safeError.code
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

function safeCoreIpcError(value: unknown): { message: string; errorId?: string; code?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (payload.ok !== false) return null
  const rawError = payload.error
  if (!rawError || typeof rawError !== 'object' || Array.isArray(rawError)) return null
  const error = rawError as Record<string, unknown>
  const message = typeof error.message === 'string' && error.message ? error.message : 'Internal error'
  return {
    message,
    errorId: typeof error.errorId === 'string' ? error.errorId : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
  }
}
