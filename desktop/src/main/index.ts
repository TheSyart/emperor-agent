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
import type { CoreApi } from '@emperor/core'

import { resolveConfig } from './config'
import { resolveAppIconPath } from './icon'
import { preparePackagedRuntime, runtimeDefaultsRoot } from './runtime-root'
import { readBounds, pickBounds } from './window-bounds'
import {
  appAssetRequestAccess,
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
  resolveStaticAssetPath,
} from './protocol'
import { createCoreHost } from './core-host'
import { CoreEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import { parsePackagedSmokeArgs, runPackagedSmoke } from './packaged-smoke'
import {
  createPackagedSmokeAttachment,
  verifyPackagedRenderer,
} from './packaged-renderer-smoke'
import {
  createTrustedRendererPolicy,
  type TrustedRendererPolicy,
} from './trusted-renderer'
import { mainWindowWebPreferences } from './window-security'
import { NodePtyHost } from './terminal-host'
import { TerminalEventBridge } from './terminal-event-bridge'
import { TERMINAL_SUBSCRIPTION_CHANNEL } from '../shared/ipc-contract'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
const packagedSmoke = parsePackagedSmokeArgs(process.argv)
let config = resolveConfig({ argv: mainArgv, env: process.env })
let legacyRuntimeRoot = config.runtimeRoot
let packagedRuntimeRevision = ''
const rendererRoot = path.join(mainDir, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: mainDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

let coreApi: CoreApi | null = null
const coreEventBridge = new CoreEventBridge()
const terminalEventBridge = new TerminalEventBridge()
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let didLoadRetry = false
const trustedRendererPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://bundle/index.html',
  developmentUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  mainWebContents: () => mainWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})
const trustedPetPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://pet/renderer.html',
  mainWebContents: () => petWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})

ipcMain.on(TERMINAL_SUBSCRIPTION_CHANNEL, (event, payload: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  terminalEventBridge.setSubscription(
    event.sender,
    terminalSubscription(payload),
  )
})

function terminalSubscription(
  payload: unknown,
): { sessionId: string; terminalId: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const sessionId =
    typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  const terminalId =
    typeof record.terminalId === 'string' ? record.terminalId.trim() : ''
  if (
    !sessionId ||
    !terminalId ||
    sessionId.length > 256 ||
    terminalId.length > 256
  )
    return null
  return { sessionId, terminalId }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

ipcMain.handle('emperor:select-directory', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  const options: OpenDialogOptions = {
    properties: ['openDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('emperor:open-path', async (event, target: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  const pathValue = typeof target === 'string' ? target.trim() : ''
  if (!pathValue) return { ok: false, error: 'path is required' }
  const error = await shell.openPath(pathValue)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('emperor:pet:open', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.showInactive()
    return { open: true }
  }
  if (!runtimeReady) return { open: false, error: 'core not ready' }
  createPetWindow()
  return { open: true }
})

ipcMain.handle('emperor:pet:close', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  return { open: false }
})

ipcMain.handle('emperor:pet:status', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  const open = petWindow !== null && !petWindow.isDestroyed()
  return { open }
})

ipcMain.handle('emperor:pet:renderer-bootstrap', async (event) => {
  trustedPetPolicy.authorizeIpc(event)
  if (!coreApi) throw new Error('core not ready')
  const boot = await coreApi.bootstrap()
  return { runtime: boot.runtime, control: boot.control }
})

ipcMain.handle('emperor:pet:renderer-close', async (event) => {
  trustedPetPolicy.authorizeIpc(event)
  if (petWindow && !petWindow.isDestroyed()) petWindow.close()
  return { open: false }
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
    packagedRuntimeRevision = prepared.manifest.runtimeRevision
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
    const access = appAssetRequestAccess(
      url.host,
      request.headers.get('Origin'),
    )
    if (!access.allowed)
      return new Response('asset origin forbidden', { status: 403 })
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
    let filePath: string | null = null
    if (url.host === 'bundle')
      filePath = resolveAssetPath(url.pathname, rendererRoot)
    else if (url.host === 'pet')
      filePath = resolveStaticAssetPath(url.pathname, petRendererRoot())
    else if (url.host === 'pet-assets')
      filePath = resolveStaticAssetPath(
        url.pathname,
        path.join(config.runtimeRoot, 'assets', 'desktop-pet', 'clawd-tank'),
      )
    if (!filePath) return new Response('asset not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function loadRenderer(): void {
  if (!mainWindow) return
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadURL('app://bundle/index.html')
}

function secureWindowNavigation(
  win: BrowserWindow,
  policy: TrustedRendererPolicy,
): void {
  win.webContents.on('will-navigate', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  win.webContents.on('will-redirect', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  win.webContents.setWindowOpenHandler((details) =>
    policy.handleWindowOpen(details),
  )
}

function createWindow(): void {
  const boundsPath = mainBoundsPath()
  mainWindow = new BrowserWindow({
    ...readBounds(boundsPath),
    title: 'Emperor Agent',
    icon: appIconPath,
    backgroundColor: '#1a1410',
    show: false,
    webPreferences: mainWindowWebPreferences(mainDir),
  })
  coreEventBridge.attach(mainWindow.webContents)
  terminalEventBridge.attach(mainWindow.webContents)
  secureWindowNavigation(mainWindow, trustedRendererPolicy)

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
    if (mainWindow) terminalEventBridge.detach(mainWindow.webContents)
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
  const petStateRoot = config.stateRoot
  const assetBaseUrl = 'app://pet-assets/'
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
      sandbox: true,
      additionalArguments: [`--emperor-asset-base-url=${assetBaseUrl}`],
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  petWindow = win
  secureWindowNavigation(win, trustedPetPolicy)
  win.loadURL('app://pet/renderer.html')
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
}

async function startup(): Promise<void> {
  app.setName('Emperor Agent')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  if (process.platform === 'win32')
    app.setAppUserModelId('com.emperor.agent.desktop')

  try {
    if (packagedSmoke && !app.isPackaged)
      throw new Error('packaged smoke mode requires a packaged application')
    prepareMainRuntime()
    coreApi = await createCoreHost({
      root: config.runtimeRoot,
      ipcMain,
      eventBridge: coreEventBridge,
      authorizeIpc: (event) => trustedRendererPolicy.authorizeIpc(event),
      coreOptions: {
        appVersion: app.getVersion(),
        ...(packagedRuntimeRevision
          ? { runtimeRevision: packagedRuntimeRevision }
          : {}),
        stateRoot: config.stateRoot,
        legacyRuntimeRoot: app.isPackaged ? legacyRuntimeRoot : null,
        legacyRuntimeSkillsHandled: app.isPackaged,
        terminalHost: new NodePtyHost(),
        terminalEventSink: terminalEventBridge.sink(),
      },
    })
    registerAppProtocol()
    if (packagedSmoke) {
      const attachment = await createPackagedSmokeAttachment(config.stateRoot)
      await runPackagedSmoke({
        core: coreApi,
        runtimeRoot: config.runtimeRoot,
        stateRoot: config.stateRoot,
        receiptPath: packagedSmoke.receiptPath,
        appVersion: app.getVersion(),
        runtimeRevision: packagedRuntimeRevision,
        commit: process.env.EMPEROR_BUILD_COMMIT || 'local',
        platform: process.platform,
        arch: process.arch,
        verifyRenderer: () => {
          const webPreferences = mainWindowWebPreferences(mainDir)
          return verifyPackagedRenderer({
            createWindow: () => {
              const win = new BrowserWindow({
                show: false,
                backgroundColor: '#1a1410',
                webPreferences,
              })
              mainWindow = win
              secureWindowNavigation(win, trustedRendererPolicy)
              return win
            },
            attachmentUrl: attachment.url,
            attachmentContent: attachment.content,
            chromiumSandboxDisabledForTest:
              process.argv.includes('--no-sandbox'),
            webPreferences,
            releaseWindow: () => {
              mainWindow = null
            },
          })
        },
      })
      await coreApi.close()
      coreApi = null
      app.exit(0)
      return
    }
  } catch (err) {
    if (packagedSmoke) {
      console.error(`packaged smoke failed: ${errMessage(err)}`)
      if (coreApi) await coreApi.close().catch(() => {})
      coreApi = null
      app.exit(1)
      return
    }
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
  if (packagedSmoke) return
  closeCoreHost()
  app.quit()
})

app.on('before-quit', () => {
  closeCoreHost()
})
