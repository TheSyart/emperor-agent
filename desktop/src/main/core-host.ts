import { CORE_API_ROUTE_OPERATIONS, CoreApi, type CoreApiCreateOptions } from '@emperor/core'
import { CoreEventBridge } from './event-bridge'
import { registerCoreIpc, type CoreApiLike, type IpcMainLike } from './ipc'

export function coreOperationKeys(): string[] {
  return CORE_API_ROUTE_OPERATIONS.map((op) => op.key)
}

export function registerCoreHostIpc(ipcMain: IpcMainLike, coreApi: CoreApiLike): void {
  registerCoreIpc(ipcMain, coreApi, coreOperationKeys())
}

export async function createCoreHost(opts: {
  root: string
  ipcMain: IpcMainLike
  eventBridge?: CoreEventBridge
  coreOptions?: Partial<CoreApiCreateOptions>
}): Promise<CoreApi> {
  const bridge = opts.eventBridge ?? new CoreEventBridge()
  const coreApi = await CoreApi.create({
    root: opts.root,
    eventSink: bridge.sink(),
    enableFirstRunOnboarding: true,
    ...opts.coreOptions,
  })
  registerCoreHostIpc(opts.ipcMain, coreApi as unknown as CoreApiLike)
  return coreApi
}
