import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core'
import { channelForCoreOperation } from '../shared/ipc-contract'

export interface CoreIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface CoreBridge {
  invokeCore<Key extends CoreOperationKey>(
    operationKey: Key,
    ...args: CoreOperationArgs<Key>
  ): Promise<CoreOperationResult<Key> | CoreIpcErrorEnvelope>
}

export function createCoreBridge(ipcRenderer: CoreIpcRendererLike): CoreBridge {
  const invokeCore: CoreBridge['invokeCore'] = async (operationKey, ...args) =>
    (await ipcRenderer.invoke(
      channelForCoreOperation(operationKey),
      ...args,
    )) as CoreOperationResult<typeof operationKey> | CoreIpcErrorEnvelope

  return {
    invokeCore,
  }
}
