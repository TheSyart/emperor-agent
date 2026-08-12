const { contextBridge, ipcRenderer } = require('electron')

function argValue(prefix) {
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : ''
}

const assetBaseUrl = argValue('--emperor-asset-base-url=')
const PET_EVENT_CHANNEL = 'emperor:pet:event'
const IPC_QUEUE_MAX = 500
const ipcEventQueue = []

ipcRenderer.on(PET_EVENT_CHANNEL, (_event, payload) => {
  if (ipcEventQueue.length < IPC_QUEUE_MAX) ipcEventQueue.push(payload)
})

contextBridge.exposeInMainWorld('emperorPet', {
  assetBaseUrl,
  readBootstrap: () => ipcRenderer.invoke('emperor:pet:renderer-bootstrap'),
  readPetEvents: async () => {
    if (!ipcEventQueue.length) return []
    return ipcEventQueue.splice(0)
  },
  closePet: () =>
    ipcRenderer.invoke('emperor:pet:renderer-close').catch(() => undefined),
})
