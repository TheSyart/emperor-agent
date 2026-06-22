import { app, BrowserWindow } from 'electron'

// Minimal skeleton — full orchestration (backend spawn, app:// protocol,
// lifecycle) is added in later tasks.
function createWindow(): void {
  const win = new BrowserWindow({ width: 1280, height: 832, show: true })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile('out/renderer/index.html')
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
