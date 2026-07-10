import { isCoreOperationKey, type CoreOperationKey } from '@emperor/core'

export const CORE_IPC_PREFIX = 'emperor:core:'
export const CORE_EVENT_CHANNEL = 'emperor:core:event'

const OPERATION_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export function channelForCoreOperation(
  operationKey: CoreOperationKey,
): string {
  const key = String(operationKey || '').trim()
  if (!OPERATION_KEY_RE.test(key) || !isCoreOperationKey(key))
    throw new Error(`invalid core IPC operation: ${operationKey}`)
  return CORE_IPC_PREFIX + key.replaceAll('.', ':')
}

export function operationFromCoreChannel(
  channel: string,
): CoreOperationKey | null {
  const raw = String(channel || '')
  if (!raw.startsWith(CORE_IPC_PREFIX)) return null
  const key = raw.slice(CORE_IPC_PREFIX.length).replaceAll(':', '.')
  return OPERATION_KEY_RE.test(key) && isCoreOperationKey(key) ? key : null
}
