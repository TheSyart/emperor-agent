import { contextBridge } from 'electron'

// Minimal preload — backend base url injection is added in a later task.
contextBridge.exposeInMainWorld('emperor', {
  version: '0.1.0',
  platform: process.platform,
})
