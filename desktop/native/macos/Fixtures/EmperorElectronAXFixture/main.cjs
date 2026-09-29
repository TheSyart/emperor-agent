const { app, BrowserWindow } = require('electron')

if (process.argv.includes('--force-accessibility')) {
  app.setAccessibilitySupportEnabled(true)
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 720,
    height: 480,
    title: 'Emperor Electron AX Fixture',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><html lang="en"><head><title>Emperor Electron AX Fixture</title></head>
      <body><h1>Emperor Electron AX Fixture</h1><label>Fixture field <input aria-label="Fixture field"></label>
      <button type="button">Fixture button</button></body></html>`),
  )
})

app.on('window-all-closed', () => app.quit())
