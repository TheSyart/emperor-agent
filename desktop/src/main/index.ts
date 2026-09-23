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
import type { CoreApi } from '@emperor/core/api'
import {
  bootstrapEmperorHome,
  legacyDefaultStateRoot,
  loadBundledToolCatalog,
} from '@emperor/core/host-capabilities'

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
import { CoreEventBridge, SessionEventBridge } from './event-bridge'
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
import { BrowserViewHost } from './browser-view'
import { registerDesktopCapabilityIpc } from './desktop-capability-ipc'
import {
  createDesktopWebFetchClient,
  type ElectronRequestLike,
} from './public-http-client'
import {
  RECOVERY_ACTION_CHANNEL,
  createRecoveryActionHandler,
  createRecoveryHtml,
  recoveryPayload,
  recoveryWindowWebPreferences,
} from './recovery'
import {
  PET_STATUS_CHANNEL,
  TERMINAL_SUBSCRIPTION_CHANNEL,
} from '../shared/ipc-contract'

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
const sessionEventBridge = new SessionEventBridge()
const terminalEventBridge = new TerminalEventBridge()
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let recoveryWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let petLastError: string | null = null
let browserViewHost: BrowserViewHost | null = null
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
  try {
    petLastError = null
    createPetWindow()
    return petStatus()
  } catch (error) {
    petLastError = errMessage(error)
    emitPetStatus()
    return petStatus()
  }
})

ipcMain.handle('emperor:pet:close', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  petLastError = null
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  return petStatus()
})

ipcMain.handle('emperor:pet:status', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  return petStatus()
})

ipcMain.handle('emperor:pet:renderer-bootstrap', async (event) => {
  trustedPetPolicy.authorizeIpc(event)
  return { event: { type: 'connection', online: runtimeReady } }
})

ipcMain.handle('emperor:pet:renderer-close', async (event) => {
  trustedPetPolicy.authorizeIpc(event)
  petLastError = null
  if (petWindow && !petWindow.isDestroyed()) petWindow.close()
  return petStatus()
})

function petStatus(): { open: boolean; error: string | null } {
  return {
    open: petWindow !== null && !petWindow.isDestroyed(),
    error: petLastError,
  }
}

function emitPetStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(PET_STATUS_CHANNEL, petStatus())
}

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
      stateRootSource:
        config.stateRootSource === 'default'
          ? 'default'
          : config.stateRootSource === 'env'
            ? 'env'
            : 'explicit',
      legacyStateRoot:
        config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null,
    })
    legacyRuntimeRoot = prepared.legacyRuntimeRoot
    packagedRuntimeRevision = prepared.manifest.runtimeRevision
    return
  }
  config = resolveConfig({ argv: mainArgv, env: process.env })
  legacyRuntimeRoot = config.runtimeRoot
  loadBundledToolCatalog()
  bootstrapEmperorHome({
    emperorHome: config.stateRoot,
    source:
      config.stateRootSource === 'default'
        ? 'default'
        : config.stateRootSource === 'env'
          ? 'env'
          : 'explicit',
    legacyHome:
      config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null,
    appVersion: app.getVersion(),
    runtimeRevision: 'development',
  })
}

function closeCoreHost(): void {
  browserViewHost?.close()
  browserViewHost = null
  sessionEventBridge.dispose()
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

async function showBootstrapRecovery(error: unknown): Promise<void> {
  runtimeReady = false
  if (coreApi) await coreApi.close().catch(() => {})
  coreApi = null
  if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.close()
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  const legacyHome =
    config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null
  const payload = recoveryPayload(error, {
    emperorHome: config.stateRoot,
    legacyHome,
  })
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 560,
    minHeight: 480,
    title: 'Emperor Agent · Recovery',
    icon: appIconPath,
    backgroundColor: '#0c0c0e',
    show: false,
    webPreferences: recoveryWindowWebPreferences(mainDir),
  })
  recoveryWindow = win
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const handle = createRecoveryActionHandler({
    senderId: win.webContents.id,
    emperorHome: payload.emperorHome,
    legacyHome: payload.legacyHome,
    retry: async () => {
      ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
      if (!win.isDestroyed()) win.close()
      recoveryWindow = null
      await startup()
    },
    openPath: (target) => shell.openPath(target),
    exit: () => app.quit(),
  })
  ipcMain.handle(RECOVERY_ACTION_CHANNEL, async (event, action: unknown) =>
    handle(event.sender.id, action),
  )
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (recoveryWindow !== win) return
    recoveryWindow = null
    ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  })
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createRecoveryHtml(payload))}`,
  )
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
        path.join(config.runtimeRoot, 'assets', 'desktop-pet', 'xiaodan'),
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
  browserViewHost = new BrowserViewHost(mainWindow)
  // A reloaded or crashed renderer lost the BrowserPane that placed the native
  // view; drop it so it cannot linger above the new UI.
  mainWindow.webContents.on('did-navigate', () => browserViewHost?.close())
  mainWindow.webContents.on('render-process-gone', () =>
    browserViewHost?.close(),
  )
  // Keep the reference: by 'closed' the window is destroyed and reading
  // mainWindow.webContents throws "Object has been destroyed".
  const mainContents = mainWindow.webContents
  coreEventBridge.attach(mainContents)
  sessionEventBridge.attach(mainContents)
  terminalEventBridge.attach(mainContents)
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
    browserViewHost?.close()
    browserViewHost = null
    coreEventBridge.detach(mainContents)
    sessionEventBridge.detach(mainContents)
    terminalEventBridge.detach(mainContents)
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
  win.once('ready-to-show', () => {
    petLastError = null
    win.showInactive()
    emitPetStatus()
  })

  // Same as the main window: webContents is unreadable once 'closed' fires.
  const petContents = win.webContents
  coreEventBridge.attachPet(petContents)

  win.on('closed', () => {
    coreEventBridge.detachPet(petContents)
    petWindow = null
    emitPetStatus()
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    petLastError = `load failed (${code}): ${description}`
    if (!win.isDestroyed()) win.close()
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    petLastError = `renderer stopped: ${details.reason}`
    if (!win.isDestroyed()) win.close()
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
      sessionEventBridge,
      authorizeIpc: (event) => trustedRendererPolicy.authorizeIpc(event),
      coreOptions: {
        appVersion: app.getVersion(),
        ...(packagedRuntimeRevision
          ? { runtimeRevision: packagedRuntimeRevision }
          : {}),
        stateRoot: config.stateRoot,
        emperorHomePrepared: true,
        stateRootSource:
          config.stateRootSource === 'default'
            ? 'default'
            : config.stateRootSource === 'env'
              ? 'env'
              : 'explicit',
        legacyRuntimeRoot: app.isPackaged ? legacyRuntimeRoot : null,
        legacyRuntimeSkillsHandled: app.isPackaged,
        terminalHost: new NodePtyHost(),
        terminalEventSink: terminalEventBridge.sink(),
        webFetchClient: createDesktopWebFetchClient({
          resolveProxy: async (url) => await app.resolveProxy(url),
          request: (options) =>
            net.request(options) as unknown as ElectronRequestLike,
        }),
      },
    })
    registerDesktopCapabilityIpc({
      ipcMain,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      browser: {
        openUrl: (input) => requireBrowserViewHost().openUrl(input),
        setBounds: (bounds) => browserViewHost?.setBounds(bounds),
        action: (action) => browserViewHost?.action(action),
        close: () => browserViewHost?.close(),
      },
      references: {
        revealPath: (input) => {
          if (!coreApi) throw new Error('core not ready')
          return coreApi.references.revealPath(input)
        },
      },
      showItemInFolder: (target) => shell.showItemInFolder(target),
      openExternal: (url) => shell.openExternal(url),
      skills: {
        folderPath: (input) => {
          if (!coreApi) throw new Error('core not ready')
          return coreApi.skills.folderPath(input)
        },
      },
      openPath: (target) => shell.openPath(target),
      selectFile: async ({ title, filters }) => {
        const options: OpenDialogOptions = {
          properties: ['openFile'],
          ...(title ? { title } : {}),
          ...(filters.length ? { filters } : {}),
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || !result.filePaths.length) return null
        return result.filePaths[0] ?? null
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
    await showBootstrapRecovery(err)
    return
  }
  runtimeReady = true

  createWindow()
}

app.whenReady().then(startup)

app.on('activate', () => {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0 && runtimeReady) createWindow()
})

app.on('window-all-closed', () => {
  if (packagedSmoke) return
  closeCoreHost()
  app.quit()
})

app.on('before-quit', () => {
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  closeCoreHost()
})

function requireBrowserViewHost(): BrowserViewHost {
  if (!browserViewHost) throw new Error('browser host is not ready')
  return browserViewHost
}
