// REL-05: the renderer reads the running app's version from main, which
// answers app.getVersion() (desktop/package.json in the package), instead of
// a number written into the preload. Trusted main window only.
import { APP_VERSION_CHANNEL } from '../shared/ipc-contract'

export interface AppVersionIpcInput {
  ipcMain: {
    handle(channel: string, handler: (event: unknown) => unknown): void
  }
  /** Throws for a sender that is not the trusted main window. */
  authorize: (event: unknown) => void
  /** app.getVersion() */
  version: () => string
}

export function registerAppVersionIpc(input: AppVersionIpcInput): void {
  input.ipcMain.handle(APP_VERSION_CHANNEL, (event) => {
    input.authorize(event)
    return input.version()
  })
}
