import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createCoreBridge } from './core-ipc'
import { createCoreEventBridge } from './core-events'

// Expose a minimal, read-only desktop surface to the renderer.
contextBridge.exposeInMainWorld('emperor', {
  version: '0.1.0',
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  selectDirectory: () => ipcRenderer.invoke('emperor:select-directory'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openPath: (target: string) => ipcRenderer.invoke('emperor:open-path', target),
  openPet: () => ipcRenderer.invoke('emperor:pet:open'),
  closePet: () => ipcRenderer.invoke('emperor:pet:close'),
  petStatus: () => ipcRenderer.invoke('emperor:pet:status'),
  ...createCoreBridge(ipcRenderer),
  ...createCoreEventBridge(ipcRenderer),
})
