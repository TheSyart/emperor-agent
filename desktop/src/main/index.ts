import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  net,
  shell,
  safeStorage,
  Tray,
  type OpenDialogOptions,
  type Rectangle,
} from 'electron'
import * as fs from 'node:fs'
import { userInfo } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreApi } from '@emperor/core/api'
import {
  bootstrapEmperorHome,
  legacyDefaultStateRoot,
  loadBundledToolCatalog,
} from '@emperor/core/host-capabilities'

import { offerMoveToApplications } from './app-location'
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
import { verifyPackagedSeatbelt } from './packaged-seatbelt-smoke'
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
  createKillSwitch,
  defaultKillSwitchAccelerator,
  type KillSwitch,
} from './computer-use/kill-switch'
import {
  createStopEntries,
  type StopEntries,
  type StopMenuItem,
} from './computer-use/stop-entries'
import { ControlOverlay } from './computer-use/control-overlay'
import { PointerOverlay } from './computer-use/pointer-overlay'
import { pointerAllowed } from './computer-use/pointer-overlay-view'
import { EmbeddedBrowserDriver } from './computer-use/embedded-browser-driver'
import { electronBrowserFactory } from './computer-use/electron-factory'
import { nativeImageCodec } from './computer-use/images'
import { DesktopComputerUsePort, hostPlatform } from './computer-use/port'
import { AgentPreview } from './computer-use/preview'
import { DesktopPreview, routedPreview } from './computer-use/desktop-preview'
import { CredentialVault } from './computer-use/credential-vault'
import { MacosDesktopDriver } from './computer-use/macos-desktop-driver'
import {
  launchMacosHelper,
  macosHelperAppPath,
  packagedMacosAppIsAdHoc,
} from './computer-use/macos-launcher'
import { NmBridgeServer } from './computer-use/nm-bridge'
import {
  EncryptedFilePairingStore,
  electronPairingCipher,
} from './computer-use/nm-bridge-store'
import {
  NmManifestRegistrar,
  resolveNmHostPath,
} from './computer-use/nm-manifest'
import { ExternalBrowserDriver } from './computer-use/external-browser-driver'
import { registerCredentialVaultIpc } from './computer-use/credential-vault-ipc'
import {
  authenticateCredentialReveal,
  credentialAuthPath,
} from './computer-use/credential-auth'
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
  AGENT_PREVIEW_FRAME_CHANNEL,
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
// Computer Use drivers are created here; the kernel owns all execution.
let computerUsePort: DesktopComputerUsePort | null = null
let embeddedBrowser: EmbeddedBrowserDriver | null = null
let nativeDesktop: MacosDesktopDriver | null = null
let nmBridge: NmBridgeServer | null = null
let externalBrowser: ExternalBrowserDriver | null = null
let credentialVault: CredentialVault | null = null
let agentPreview: AgentPreview | null = null
let desktopPreview: DesktopPreview | null = null
let killSwitch: KillSwitch | null = null
let stopEntries: StopEntries | null = null
let stopTray: Tray | null = null
let controlOverlay: ControlOverlay | null = null
let pointerOverlay: PointerOverlay | null = null
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

function syncControlOverlay(): void {
  const view = coreApi?.host.computerUse?.service.statusView() ?? null
  controlOverlay?.sync(view)
  if (!pointerAllowed(view)) pointerOverlay?.clear()
  stopEntries?.sync({
    enabled: view?.enabled === true,
    stopped: view?.stopped === true,
    shortcutRegistered: killSwitch?.status().registered === true,
  })
}

let retentionTimer: ReturnType<typeof setInterval> | null = null

/** 00 §10 保留策略: sweep old inbox downloads now and every six hours. */
function startDownloadRetention(): void {
  const sweep = (): void => {
    const days =
      coreApi?.host.computerUse?.service.statusView().downloadRetentionDays ?? 0
    void embeddedBrowser?.downloads?.sweep(days).catch(() => 0)
  }
  sweep()
  retentionTimer ??= setInterval(sweep, 6 * 60 * 60 * 1000)
  retentionTimer.unref?.()
}

function stopMenu(items: readonly StopMenuItem[]): Menu {
  return Menu.buildFromTemplate(
    items.map((item) => ({
      label: item.label,
      enabled: item.enabled,
      ...(item.click === undefined ? {} : { click: item.click }),
    })),
  )
}

/** Dock menu and (when the shortcut is taken) a tray icon to stop (§6.6). */
function createElectronStopEntries(): StopEntries {
  return createStopEntries(
    {
      setDockMenu: (items) => {
        app.dock?.setMenu(stopMenu(items ?? []))
      },
      showTray: (items, tooltip) => {
        if (stopTray === null) {
          const icon =
            process.platform === 'darwin'
              ? nativeImage.createFromNamedImage('NSStopProgressTemplate')
              : nativeImage
                  .createFromPath(appIconPath)
                  .resize({ width: 16, height: 16 })
          stopTray = new Tray(icon)
        }
        stopTray.setToolTip(tooltip)
        stopTray.setContextMenu(stopMenu(items))
      },
      hideTray: () => {
        stopTray?.destroy()
        stopTray = null
      },
    },
    {
      stop: () => {
        void coreApi?.computerUse.stop()
      },
      showApp: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else if (runtimeReady) createWindow()
      },
    },
  )
}

ipcMain.on(TERMINAL_SUBSCRIPTION_CHANNEL, (event, payload: unknown) => {
  // One-way: an untrusted or torn-down sender is dropped, never thrown.
  try {
    trustedRendererPolicy.authorizeIpc(event)
  } catch {
    return
  }
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

/**
 * Computer use is always offered to Core; the user's master switch (off by
 * default) decides whether any GUI tool is registered. The hidden host
 * window is created on the first Agent tab only.
 */
function createComputerUseHost(): void {
  credentialVault = new CredentialVault({
    path: path.join(config.stateRoot, 'computer-use', 'vault.json'),
    storage: safeStorage,
  })
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: hostPlatform(process.platform),
    profilesRoot: path.join(config.stateRoot, 'browser', 'profiles'),
    downloadsRoot: path.join(config.stateRoot, 'browser', 'downloads'),
    credentials: credentialVault,
    credentialVisibility: (targetId, visible) =>
      agentPreview?.setSensitive(targetId, visible),
    // Uploads: the user picks files in the system dialog; the Agent never
    // names a path (spec 00 §7.5).
    pickFiles: async ({ title, multiple }) => {
      const options: OpenDialogOptions = {
        title,
        message: title,
        buttonLabel: '上传',
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      }
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths
    },
  })
  embeddedBrowser = driver
  agentPreview = new AgentPreview({
    manager: driver.manager,
    send: (frame) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed())
        contents.send(AGENT_PREVIEW_FRAME_CHANNEL, frame)
    },
    canTakeInput: (targetId) =>
      coreApi?.host.computerUse?.service.registry.get(targetId)?.control ===
      'user-takeover',
  })
  desktopPreview = new DesktopPreview({
    source: () => nativeDesktop,
    send: (frame) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed())
        contents.send(AGENT_PREVIEW_FRAME_CHANNEL, frame)
    },
  })
  if (process.platform === 'darwin') {
    const launchOptions = {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: path.resolve(mainDir, '..', '..'),
    }
    if (fs.existsSync(macosHelperAppPath(launchOptions)))
      nativeDesktop = new MacosDesktopDriver({
        connect: () => launchMacosHelper(launchOptions),
        credentials: credentialVault,
        pointer: (signal) => {
          if (
            signal.kind !== 'move' ||
            pointerAllowed(
              coreApi?.host.computerUse?.service.statusView() ?? null,
            )
          )
            pointerOverlay?.signal(signal)
        },
        previewBuild: app.isPackaged
          ? packagedMacosAppIsAdHoc().catch(() => false)
          : Promise.resolve(false),
      })
    nmBridge = new NmBridgeServer({
      // The packaged smoke runs beside a user's live Emperor process. Use
      // a short per-process socket path so it cannot interrupt the live
      // Chrome connection or exceed macOS's Unix socket path limit.
      ...(packagedSmoke
        ? {
            socketPath: path.join(
              '/tmp',
              `emperor-cu-smoke-${userInfo().uid}`,
              `nm-${process.pid}.sock`,
            ),
          }
        : {
            // 01 §11: keep Chrome/Edge manifests on this app's host. A dev
            // host outside an app bundle cannot verify main, so only a
            // packaged build repoints or creates them.
            manifests: new NmManifestRegistrar({
              hostPath: app.isPackaged
                ? resolveNmHostPath({
                    packaged: true,
                    resourcesPath: process.resourcesPath,
                  })
                : null,
            }),
          }),
      pairings: new EncryptedFilePairingStore(
        path.join(
          config.stateRoot,
          'computer-use',
          'browser-pairings',
          'pairings.json',
        ),
        electronPairingCipher(safeStorage),
      ),
    })
    externalBrowser = new ExternalBrowserDriver(nmBridge)
  }
  computerUsePort = new DesktopComputerUsePort({
    platform: process.platform,
    embeddedBrowser: () => driver,
    externalBrowser: () => externalBrowser,
    credentials: () => credentialVault,
    desktop: () => nativeDesktop,
    indicate: () => queueMicrotask(syncControlOverlay),
  })
  killSwitch = createKillSwitch({
    shortcuts: globalShortcut,
    platform: process.platform,
    onTrigger: () => {
      void coreApi?.computerUse.stop()
    },
  })
}

function closeAgentBrowser(final: boolean): void {
  // Save recovery hints before the driver emits target-lost events. On macOS
  // the main window may close before CoreApi.close() gets to its shutdown.
  coreApi?.host.computerUse?.service.rememberRestorableTabs()
  agentPreview?.stopAll()
  desktopPreview?.stopAll()
  // Agent tabs live in a hidden window that would keep window-all-closed
  // from firing; close them with the main window. The driver stays usable
  // for a reopened window (the pet keeps the app alive) until Core closes.
  const driver = embeddedBrowser
  if (driver)
    void (final ? driver.shutdown() : driver.closeAll()).catch(() => undefined)
}

function closeCoreHost(): void {
  controlOverlay?.dispose()
  controlOverlay = null
  pointerOverlay?.dispose()
  pointerOverlay = null
  browserViewHost?.close()
  browserViewHost = null
  closeAgentBrowser(true)
  void nativeDesktop?.shutdown().catch(() => undefined)
  externalBrowser?.dispose()
  externalBrowser = null
  void nmBridge?.stop().catch(() => undefined)
  nmBridge = null
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
  // The recovery page shows only a code; keep the cause for diagnosis.
  console.error(`Emperor startup failed: ${errMessage(error)}`)
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
  controlOverlay ??= new ControlOverlay(() => {
    void coreApi?.computerUse.stop()
  })
  pointerOverlay ??= new PointerOverlay()
  syncControlOverlay()
  browserViewHost = new BrowserViewHost(mainWindow)
  // A reloaded or crashed renderer lost the BrowserPane that placed the native
  // view; drop it so it cannot linger above the new UI.
  // 00 §12: while the UI is gone nobody can watch the Agent, so its targets
  // pause (they stay open); the reloaded panes let the user resume or end.
  const uiDisconnected = (): void => {
    browserViewHost?.close()
    agentPreview?.stopAll()
    desktopPreview?.stopAll()
    coreApi?.host.computerUse?.service.pauseForUiDisconnect()
  }
  mainWindow.webContents.on('did-navigate', uiDisconnected)
  mainWindow.webContents.on('render-process-gone', uiDisconnected)
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
    controlOverlay?.dispose()
    controlOverlay = null
    pointerOverlay?.dispose()
    pointerOverlay = null
    browserViewHost?.close()
    browserViewHost = null
    closeAgentBrowser(false)
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

  // Opened from its download location, the app runs from a random path
  // and computer use permissions would reset each launch: offer the move.
  if (
    !packagedSmoke &&
    (await offerMoveToApplications({
      platform: process.platform,
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
      ask: async (options) =>
        (
          await dialog.showMessageBox({
            type: 'info',
            message: options.message,
            detail: options.detail,
            buttons: [...options.buttons],
            defaultId: 0,
            cancelId: 1,
          })
        ).response,
      moveToApplications: () => app.moveToApplicationsFolder(),
    }))
  )
    return

  try {
    if (packagedSmoke && !app.isPackaged)
      throw new Error('packaged smoke mode requires a packaged application')
    prepareMainRuntime()
    createComputerUseHost()
    // The Chrome/Edge bridge is optional: if another Emperor holds its
    // socket, start without it and let the driver report why.
    if (nmBridge && !(await nmBridge.startOrDegrade()))
      console.warn(
        `Chrome/Edge connection unavailable: ${nmBridge.unavailableReason ?? 'unknown'}`,
      )
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
        ...(computerUsePort
          ? {
              computerUsePort,
              computerUseKillSwitch: () =>
                killSwitch?.status() ?? { accelerator: '', registered: false },
              // The emergency-stop shortcut is held only while computer use
              // is on, so it never steals the combination otherwise.
              computerUseEnabledChanged: (enabled: boolean) => {
                if (enabled) killSwitch?.register()
                else killSwitch?.unregister()
                syncControlOverlay()
              },
              // Settings › 电脑操作 changed the stop shortcut: applied at
              // once while on, remembered while off.
              computerUseKillSwitchChanged: (accelerator: string | null) => {
                killSwitch?.setAccelerator(
                  accelerator ?? defaultKillSwitchAccelerator(process.platform),
                )
                syncControlOverlay()
              },
            }
          : {}),
        terminalHost: new NodePtyHost(),
        terminalEventSink: terminalEventBridge.sink(),
        webFetchClient: createDesktopWebFetchClient({
          resolveProxy: async (url) => await app.resolveProxy(url),
          request: (options) =>
            net.request(options) as unknown as ElectronRequestLike,
        }),
      },
    })
    const savedAccelerator = coreApi.host.computerUseKillSwitchAccelerator()
    if (savedAccelerator !== undefined)
      killSwitch?.setAccelerator(savedAccelerator)
    if (coreApi.host.computerUse?.enabled === true) killSwitch?.register()
    if (computerUsePort) stopEntries ??= createElectronStopEntries()
    syncControlOverlay()
    startDownloadRetention()
    registerDesktopCapabilityIpc({
      ipcMain,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      ...(nativeDesktop ? { macHelper: nativeDesktop } : {}),
      ...(nmBridge ? { browserPairings: nmBridge } : {}),
      externalAttachedCount: () => externalBrowser?.listAttached().length ?? 0,
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
      ...(agentPreview
        ? {
            agentPreview: desktopPreview
              ? routedPreview(agentPreview, desktopPreview)
              : agentPreview,
          }
        : {}),
      agentDownloads: {
        reveal: (downloadId) => {
          const file = embeddedBrowser?.downloads?.pathOf(downloadId)
          if (file === undefined || !fs.existsSync(file)) return false
          shell.showItemInFolder(file)
          return true
        },
        // 00 §7.5: the user moves a download into the conversation's
        // workspace; the Agent never picks the destination.
        saveAs: async (downloadId) => {
          const inbox = embeddedBrowser?.downloads
          const from = inbox?.pathOf(downloadId)
          if (!inbox || from === undefined || !fs.existsSync(from))
            return undefined
          const options = {
            title: '另存下载的文件',
            defaultPath: path.join(
              app.getPath('downloads'),
              path.basename(from),
            ),
          }
          const picked = mainWindow
            ? await dialog.showSaveDialog(mainWindow, options)
            : await dialog.showSaveDialog(options)
          if (picked.canceled || !picked.filePath) return null
          return await inbox.moveToFile(downloadId, picked.filePath)
        },
        moveToWorkspace: async (downloadId) => {
          const inbox = embeddedBrowser?.downloads
          const owner = inbox?.ownerOf(downloadId)
          if (!inbox || owner === undefined || !coreApi) return undefined
          const workspace = coreApi.host.sessionWorkspaceRoot(owner)
          return await inbox.moveTo(
            downloadId,
            path.join(workspace, 'downloads'),
          )
        },
      },
    })
    if (credentialVault)
      registerCredentialVaultIpc({
        ipcMain,
        authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
        vault: credentialVault,
        authenticateReveal:
          process.platform === 'darwin'
            ? () =>
                authenticateCredentialReveal(
                  credentialAuthPath({
                    packaged: app.isPackaged,
                    mainDir,
                    resourcesPath: process.resourcesPath,
                  }),
                )
            : undefined,
      })
    registerAppProtocol()
    if (packagedSmoke) {
      if (process.platform === 'darwin') {
        const probe = 'emperor-packaged-safe-storage-probe'
        if (
          !safeStorage.isEncryptionAvailable() ||
          safeStorage.decryptString(safeStorage.encryptString(probe)) !== probe
        )
          throw new Error('packaged safeStorage round trip failed')
        // The master-password KDF must exist in Electron's crypto, which
        // lacks some of Node's (no Argon2), so derive it here for real.
        const vault = new CredentialVault({
          path: path.join(config.stateRoot, 'packaged-smoke-vault.json'),
          storage: safeStorage,
        })
        vault.setMasterPassword(`${probe}-master`, { biometric: true })
        vault.lock()
        vault.unlockWithBiometrics()
        vault.lock()
        if (!vault.unlock(`${probe}-master`))
          throw new Error('packaged credential vault round trip failed')
        vault.lock()
      }
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
        verifySeatbelt: verifyPackagedSeatbelt,
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

app.on('will-quit', () => {
  killSwitch?.dispose()
  stopEntries?.dispose()
})

function requireBrowserViewHost(): BrowserViewHost {
  if (!browserViewHost) throw new Error('browser host is not ready')
  return browserViewHost
}
