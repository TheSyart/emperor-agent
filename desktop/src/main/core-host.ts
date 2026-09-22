import {
  CoreApi,
  coreOperationKeys as registryCoreOperationKeys,
  type CoreApiCreateOptions,
} from '@emperor/core/api'
import { CoreEventBridge, SessionEventBridge } from './event-bridge'
import {
  registerCoreIpc,
  type CoreApiLike,
  type IpcAuthorizer,
  type IpcMainLike,
} from './ipc'

export function coreOperationKeys() {
  return registryCoreOperationKeys()
}

export function registerCoreHostIpc(
  ipcMain: IpcMainLike,
  coreApi: CoreApiLike,
  authorizeIpc?: IpcAuthorizer,
): void {
  registerCoreIpc(ipcMain, coreApi, coreOperationKeys(), {
    ...(authorizeIpc ? { authorize: authorizeIpc } : {}),
  })
}

export async function createCoreHost(opts: {
  root: string
  ipcMain: IpcMainLike
  eventBridge?: CoreEventBridge
  /** Raw session-log stream (`sessions.watch` filtered); created when omitted. */
  sessionEventBridge?: SessionEventBridge
  coreOptions?: Partial<CoreApiCreateOptions>
  authorizeIpc?: IpcAuthorizer
}): Promise<CoreApi> {
  const bridge = opts.eventBridge ?? new CoreEventBridge()
  const coreApi = await CoreApi.create({
    root: opts.root,
    eventSink: bridge.sink(),
    enableFirstRunOnboarding: true,
    ...opts.coreOptions,
  })
  const sessionBridge = opts.sessionEventBridge ?? new SessionEventBridge()
  sessionBridge.setWatchFilter((sessionId) =>
    coreApi.isSessionWatched(sessionId),
  )
  coreApi.host.rawTap(sessionBridge.tap())
  registerCoreHostIpc(opts.ipcMain, coreApi, opts.authorizeIpc)
  return coreApi
}
