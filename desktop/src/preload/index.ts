import { contextBridge, ipcRenderer } from 'electron'
import { createCoreBridge } from './core-ipc'
import { createCoreEventBridge } from './core-events'

// Expose a minimal, read-only desktop surface to the renderer.
contextBridge.exposeInMainWorld('emperor', {
  version: '0.1.0',
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('emperor:select-directory'),
  openPath: (target: string) => ipcRenderer.invoke('emperor:open-path', target),
  ...createCoreBridge(ipcRenderer),
  ...createCoreEventBridge(ipcRenderer),
})
