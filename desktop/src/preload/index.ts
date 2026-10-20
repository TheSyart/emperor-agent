import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createCoreBridge } from './core-ipc'
import { createCoreEventBridge } from './core-events'
import { createTerminalEventBridge } from './terminal-events'
import { createDesktopCapabilityBridge } from './desktop-capabilities'
import { createDictationBridge } from './dictation'
import {
  OPEN_PATH_CHANNEL,
  PET_CLOSE_CHANNEL,
  PET_OPEN_CHANNEL,
  PET_STATUS_CHANNEL,
  PET_STATUS_REQUEST_CHANNEL,
  SCREENSHOT_CAPTURE_CHANNEL,
  SELECT_DIRECTORY_CHANNEL,
  type OpenPathTarget,
} from '../shared/ipc-contract'

// Expose a minimal, read-only desktop surface to the renderer.
contextBridge.exposeInMainWorld('emperor', {
  version: '0.1.0',
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  selectDirectory: () => ipcRenderer.invoke(SELECT_DIRECTORY_CHANNEL),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  /** A folder Core vouches for (never a path of the renderer's choosing). */
  openPath: (target: OpenPathTarget) =>
    ipcRenderer.invoke(OPEN_PATH_CHANNEL, target),
  /** The composer's + › 截图: the system's region capture (macOS). */
  captureScreenshot: () => ipcRenderer.invoke(SCREENSHOT_CAPTURE_CHANNEL),
  openPet: () => ipcRenderer.invoke(PET_OPEN_CHANNEL),
  closePet: () => ipcRenderer.invoke(PET_CLOSE_CHANNEL),
  petStatus: () => ipcRenderer.invoke(PET_STATUS_REQUEST_CHANNEL),
  onPetStatus: (listener: (status: unknown) => void) => {
    const wrapped = (_event: unknown, status: unknown) => listener(status)
    ipcRenderer.on(PET_STATUS_CHANNEL, wrapped)
    return () => ipcRenderer.removeListener(PET_STATUS_CHANNEL, wrapped)
  },
  ...createDesktopCapabilityBridge(ipcRenderer),
  ...createDictationBridge(ipcRenderer),
  ...createCoreBridge(ipcRenderer),
  ...createCoreEventBridge(ipcRenderer),
  ...createTerminalEventBridge(ipcRenderer),
})
