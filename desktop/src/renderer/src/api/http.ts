import {
  CORE_BRIDGE_UNAVAILABLE_MESSAGE,
  hasCoreBridge,
  invokeCore,
} from './backend'
import type {
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core'

/**
 * Core IPC 薄封装：按 op 名直接调用（W4 移除了假 REST 路由表）。
 * 只做 bridge 可用性检查与返回值类型标注。
 */
export async function core<Key extends CoreOperationKey>(
  operation: Key,
  ...args: CoreOperationArgs<Key>
): Promise<CoreOperationResult<Key>> {
  if (!hasCoreBridge()) throw new Error(CORE_BRIDGE_UNAVAILABLE_MESSAGE)
  return invokeCore(operation, ...args)
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
