import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  net,
  shell,
  type OpenDialogOptions,
  type Rectangle,
} from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultStateRoot } from '@emperor/core'

import { resolveConfig } from './config'
import { resolveAppIconPath } from './icon'
import { preparePackagedRuntime, runtimeDefaultsRoot } from './runtime-root'
import { readBounds, pickBounds } from './window-bounds'
import {
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
} from './protocol'
import { createCoreHost } from './core-host'
import { CoreEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import { resolveMainPreloadPath } from './preload-path'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
let config = resolveConfig({ argv: mainArgv, env: process.env })
let legacyRuntimeRoot = config.runtimeRoot
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
let petWindow: BrowserWindow | null = null
let didLoadRetry = false

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
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

ipcMain.handle('emperor:open-path', async (_event, target: unknown) => {
  const pathValue = typeof target === 'string' ? target.trim() : ''
  if (!pathValue) return { ok: false, error: 'path is required' }
  const error = await shell.openPath(pathValue)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('emperor:pet:open', async () => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.showInactive()
    return { open: true }
  }
  if (!runtimeReady) return { open: false, error: 'core not ready' }
  createPetWindow()
  return { open: true }
})

ipcMain.handle('emperor:pet:close', async () => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  return { open: false }
})

ipcMain.handle('emperor:pet:status', async () => {
  const open = petWindow !== null && !petWindow.isDestroyed()
  return { open }
})

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function mainBoundsPath(): string {
  return path.join(config.stateRoot, 'memory', 'desktop', 'window.json')
}

function prepareMainRuntime(): void {
  if (app.isPackaged) {
    const signedRoot = runtimeDefaultsRoot(process.resourcesPath)
    config = resolveConfig({
      argv: mainArgv,
      env: process.env,
      forcedRuntimeRoot: signedRoot,
    })
    const prepared = preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      stateRoot: config.stateRoot,
      appVersion: app.getVersion(),
    })
    legacyRuntimeRoot = prepared.legacyRuntimeRoot
    return
  }
  config = resolveConfig({ argv: mainArgv, env: process.env })
  legacyRuntimeRoot = config.runtimeRoot
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
      const attachmentPath = resolveAttachmentRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
      if (!attachmentPath)
        return new Response('attachment not found', { status: 404 })
      return net.fetch(pathToFileURL(attachmentPath).toString())
    }
    if (url.host === 'media') {
      const mediaPath = resolveMediaRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
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

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      console.error(`did-fail-load: ${errorCode} ${errorDescription}`)
      if (!didLoadRetry) {
        didLoadRetry = true
        loadRenderer()
      } else {
        fail('页面加载失败', `无法加载前端（${errorDescription}）。`)
      }
    },
  )

  mainWindow.on('close', () => {
    if (!mainWindow) return
    try {
      fs.mkdirSync(path.dirname(boundsPath), { recursive: true })
      const payload = pickBounds(mainWindow.getBounds())
      fs.writeFileSync(
        boundsPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      )
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
  return path.resolve(mainDir, '..', 'pet')
}

function petStateDir(root: string): string {
  return path.join(root, 'memory', 'desktop_pet')
}

function readPetBounds(
  boundsPath: string,
): Partial<Rectangle> & { width: number; height: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsPath, 'utf8'))
    const width = Math.max(Number(raw.width) || 300, 300)
    const height = Math.max(Number(raw.height) || 340, 340)
    const bounds: Partial<Rectangle> & { width: number; height: number } = {
      width,
      height,
    }
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
    fs.writeFileSync(
      boundsPath,
      `${JSON.stringify(win.getBounds(), null, 2)}\n`,
      'utf8',
    )
  } catch {
    // Best-effort persistence; never block pet shutdown on disk errors.
  }
}

function createPetWindow(): void {
  const root = config.runtimeRoot
  const petStateRoot = process.env.EMPEROR_CONFIG_DIR || defaultStateRoot()
  const assetBaseUrl = pathToFileURL(
    path.join(root, 'assets', 'desktop-pet', 'clawd-tank') + path.sep,
  ).href
  const boundsPath = path.join(petStateDir(petStateRoot), 'window.json')
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
        `--emperor-config-dir=${petStateRoot}`,
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

  // Wire pet into core event bridge so it receives live runtime events.
  coreEventBridge.attach(win.webContents)

  win.on('closed', () => {
    coreEventBridge.detach(win.webContents)
    petWindow = null
  })

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

  petWindow = win
}

async function startup(): Promise<void> {
  app.setName('Emperor Agent')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  if (process.platform === 'win32')
    app.setAppUserModelId('com.emperor.agent.desktop')

  try {
    prepareMainRuntime()
    registerAppProtocol()
    coreApi = await createCoreHost({
      root: config.runtimeRoot,
      ipcMain,
      eventBridge: coreEventBridge,
      coreOptions: {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot: app.isPackaged ? legacyRuntimeRoot : null,
        legacyRuntimeSkillsHandled: app.isPackaged,
      },
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
  if (BrowserWindow.getAllWindows().length === 0 && runtimeReady) createWindow()
})

app.on('window-all-closed', () => {
  closeCoreHost()
  app.quit()
})

app.on('before-quit', () => {
  closeCoreHost()
})
