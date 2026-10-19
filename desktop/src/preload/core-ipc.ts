import type {
  CoreIpcErrorEnvelope,
  CoreOperationArgs,
  CoreOperationKey,
  CoreOperationResult,
} from '@emperor/core/api'
import {
  channelForCoreOperation,
  coreCallEnvelope,
} from '../shared/ipc-contract'

export interface CoreIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface CoreBridge {
  invokeCore<Key extends CoreOperationKey>(
    operationKey: Key,
    ...args: CoreOperationArgs<Key>
  ): Promise<CoreOperationResult<Key> | CoreIpcErrorEnvelope>
  /**
   * The session the renderer shows (null: none, such as a draft). Every
   * core call carries it, so Core never has to guess (KRN-01).
   */
  setViewingSession(sessionId: string | null): void
}

export function createCoreBridge(ipcRenderer: CoreIpcRendererLike): CoreBridge {
  let viewing: string | null = null
  const invokeCore: CoreBridge['invokeCore'] = async (operationKey, ...args) =>
    (await ipcRenderer.invoke(
      channelForCoreOperation(operationKey),
      coreCallEnvelope(viewing),
      ...args,
    )) as CoreOperationResult<typeof operationKey> | CoreIpcErrorEnvelope

  return {
    invokeCore,
    setViewingSession: (sessionId) => {
      viewing =
        typeof sessionId === 'string' && sessionId.trim()
          ? sessionId.trim().slice(0, 256)
          : null
    },
  }
}
