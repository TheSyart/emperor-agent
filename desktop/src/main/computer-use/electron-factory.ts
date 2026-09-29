/** Real Electron constructors for the Agent browser session manager. */

import { BaseWindow, session, WebContentsView } from 'electron'
import type { ElectronFactory } from './browser-session-manager'

export function electronBrowserFactory(): ElectronFactory {
  return {
    createHost: (size) => {
      const window = new BaseWindow({
        show: false,
        width: size.width,
        height: size.height,
        skipTaskbar: true,
        focusable: false,
        title: 'Emperor Agent browser',
      })
      return {
        contentView: {
          addChildView: (view) =>
            window.contentView.addChildView(view as WebContentsView),
          removeChildView: (view) =>
            window.contentView.removeChildView(view as WebContentsView),
        },
        destroy: () => window.destroy(),
        isDestroyed: () => window.isDestroyed(),
      }
    },
    createView: (webPreferences) => new WebContentsView({ webPreferences }),
    sessionFromPartition: (partition) => session.fromPartition(partition),
    sessionFromPath: (path) => session.fromPath(path),
  }
}
