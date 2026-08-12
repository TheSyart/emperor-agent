import type { CoreOperationKey } from '@emperor/core/api'

export const CORE_IPC_PREFIX = 'emperor:core:'
export const CORE_EVENT_CHANNEL = 'emperor:core:event'
export const PET_EVENT_CHANNEL = 'emperor:pet:event'
export const PET_STATUS_CHANNEL = 'emperor:pet:status-event'
export const TERMINAL_EVENT_CHANNEL = 'emperor:terminal:event'
export const TERMINAL_SUBSCRIPTION_CHANNEL = 'emperor:terminal:subscription'
export const PREVIEW_OPEN_CHANNEL = 'emperor:preview:open'
export const PREVIEW_EXTERNAL_CHANNEL = 'emperor:preview:external'
export const PREVIEW_BOUNDS_CHANNEL = 'emperor:preview:bounds'
export const PREVIEW_ACTION_CHANNEL = 'emperor:preview:action'
export const PREVIEW_CLOSE_CHANNEL = 'emperor:preview:close'
export const PREVIEW_STATE_CHANNEL = 'emperor:preview:state'
export const REFERENCE_REVEAL_CHANNEL = 'emperor:reference:reveal'
export const EXTERNAL_OPEN_CHANNEL = 'emperor:external:open'

const OPERATION_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export function channelForCoreOperation(
  operationKey: CoreOperationKey,
): string {
  const key = String(operationKey || '').trim()
  if (!OPERATION_KEY_RE.test(key))
    throw new Error(`invalid core IPC operation: ${operationKey}`)
  return CORE_IPC_PREFIX + key.replaceAll('.', ':')
}
