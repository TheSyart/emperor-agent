import { app, BrowserWindow, dialog, ipcMain, protocol, net, type OpenDialogOptions, type Rectangle } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveConfig } from './config'
import { resolveAppIconPath } from './icon'
import {
  initializePackagedRuntime,
  packagedRuntimeRoot,
  runtimeDefaultsRoot,
} from './runtime-root'
import { readBounds, pickBounds } from './window-bounds'
import { resolveAssetPath, resolveAttachmentRawPath, resolveMediaRawPath } from './protocol'
import { createCoreHost } from './core-host'
import { CoreEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import { resolveMainPreloadPath } from './preload-path'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
const petWindowMode = mainArgv.includes('--pet-window')
let config = resolveConfig({ argv: mainArgv, env: process.env })
const rendererRoot = path.join(mainDir, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: mainDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

let coreApi: { close(): Promise<void> } | null = null
const coreEventBridge = new CoreEventBridge()
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let didLoadRetry = false

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

ipcMain.handle('emperor:select-directory', async () => {
  const options: OpenDialogOptions = {
    properties: ['openDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
  return undefined
}

function mainBoundsPath(): string {
  return path.join(config.root, 'memory', 'desktop', 'window.json')
}

function prepareMainRuntime(): void {
  const defaultRoot = app.isPackaged ? packagedRuntimeRoot(app.getPath('userData')) : undefined
  config = resolveConfig({ argv: mainArgv, env: process.env, defaultRoot })
  if (app.isPackaged) {
    initializePackagedRuntime({
      root: config.root,
      defaultsRoot: runtimeDefaultsRoot(process.resourcesPath),
    })
  }
}

function closeCoreHost(): void {
  if (!coreApi) return
  const current = coreApi
  coreApi = null
  void current.close().catch((err) => {
    console.error(`failed to close CoreApi: ${errMessage(err)}`)
  })
}

function fail(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  app.quit()
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host === 'attachments') {
      const attachmentPath = resolveAttachmentRawPath(request.url, config.root)
      if (!attachmentPath) return new Response('attachment not found', { status: 404 })
      return net.fetch(pathToFileURL(attachmentPath).toString())
    }
    if (url.host === 'media') {
      const mediaPath = resolveMediaRawPath(request.url, config.root)
      if (!mediaPath) return new Response('media not found', { status: 404 })
      return net.fetch(pathToFileURL(mediaPath).toString())
    }
    const { pathname } = url
    const filePath = resolveAssetPath(pathname, rendererRoot)
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function loadRenderer(): void {
  if (!mainWindow) return
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadURL('app://bundle/index.html')
}

function createWindow(): void {
  const boundsPath = mainBoundsPath()
  mainWindow = new BrowserWindow({
    ...readBounds(boundsPath),
    title: 'Emperor Agent',
    icon: appIconPath,
    backgroundColor: '#1a1410',
    show: false,
    webPreferences: {
      preload: resolveMainPreloadPath(mainDir),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [],
    },
  })
  coreEventBridge.attach(mainWindow.webContents)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`did-fail-load: ${errorCode} ${errorDescription}`)
    if (!didLoadRetry) {
      didLoadRetry = true
      loadRenderer()
    } else {
      fail('页面加载失败', `无法加载前端（${errorDescription}）。`)
    }
  })

  mainWindow.on('close', () => {
    if (!mainWindow) return
    try {
      fs.mkdirSync(path.dirname(boundsPath), { recursive: true })
      const payload = pickBounds(mainWindow.getBounds())
      fs.writeFileSync(boundsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // Best-effort persistence; never block window close on disk errors.
    }
  })
  mainWindow.on('closed', () => {
    if (mainWindow) coreEventBridge.detach(mainWindow.webContents)
    mainWindow = null
  })

  loadRenderer()
}

function petRendererRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'desktop-pet')
  return path.resolve(mainDir, '..', '..', '..', 'desktop-pet')
}

function petStateDir(root: string): string {
  return path.join(root, 'memory', 'desktop_pet')
}

function readPetBounds(boundsPath: string): Partial<Rectangle> & { width: number; height: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsPath, 'utf8'))
    const width = Math.max(Number(raw.width) || 300, 300)
    const height = Math.max(Number(raw.height) || 340, 340)
    const bounds: Partial<Rectangle> & { width: number; height: number } = { width, height }
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      bounds.x = Math.round(raw.x)
      bounds.y = Math.round(raw.y)
    }
    return bounds
  } catch {
    return { width: 300, height: 340 }
  }
}

function savePetBounds(win: BrowserWindow, boundsPath: string): void {
  if (!win || win.isDestroyed()) return
  try {
    fs.mkdirSync(path.dirname(boundsPath), { recursive: true })
    fs.writeFileSync(boundsPath, `${JSON.stringify(win.getBounds(), null, 2)}\n`, 'utf8')
  } catch {
    // Best-effort persistence; never block pet shutdown on disk errors.
  }
}

function createPetWindow(): void {
  const root =
    argValue(mainArgv, '--root') ||
    process.env.EMPEROR_AGENT_ROOT ||
    (app.isPackaged ? packagedRuntimeRoot(app.getPath('userData')) : path.resolve(mainDir, '..', '..', '..'))
  const assetBaseUrl = pathToFileURL(path.join(root, 'assets', 'desktop-pet', 'clawd-tank') + path.sep).href
  const boundsPath = path.join(petStateDir(root), 'window.json')
  const rootDir = petRendererRoot()
  const win = new BrowserWindow({
    ...readPetBounds(boundsPath),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--emperor-root=${root}`,
        `--emperor-asset-base-url=${assetBaseUrl}`,
      ],
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.loadFile(path.join(rootDir, 'renderer.html'))
  win.once('ready-to-show', () => win.showInactive())

  let saveTimer: NodeJS.Timeout | null = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      savePetBounds(win, boundsPath)
    }, 180)
  }
  win.on('move', scheduleSave)
  win.on('close', () => savePetBounds(win, boundsPath))
}

async function startup(): Promise<void> {
  app.setName('Emperor Agent')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  if (process.platform === 'win32') app.setAppUserModelId('com.emperor.agent.desktop')

  if (petWindowMode) {
    if (process.platform === 'darwin') app.dock?.hide()
    createPetWindow()
    return
  }

  prepareMainRuntime()
  registerAppProtocol()

  try {
    coreApi = await createCoreHost({
      root: config.root,
      ipcMain,
      eventBridge: coreEventBridge,
    })
  } catch (err) {
    fail('CoreApi 初始化失败', errMessage(err))
    return
  }
  runtimeReady = true

  createWindow()
}

app.whenReady().then(startup)

app.on('activate', () => {
  if (petWindowMode) {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0 && runtimeReady) createWindow()
})

app.on('window-all-closed', () => {
  if (petWindowMode) {
    app.quit()
    return
  }
  closeCoreHost()
  app.quit()
})

app.on('before-quit', () => {
  closeCoreHost()
})
