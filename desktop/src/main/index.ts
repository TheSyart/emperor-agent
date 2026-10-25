import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  nativeTheme,
  net,
  screen,
  session,
  shell,
  systemPreferences,
  type OpenDialogOptions,
  type Rectangle,
  type SaveDialogOptions,
  type WebContents,
} from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { userInfo } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreApi } from '@emperor/core/api'
import {
  applyPendingHomeRestore,
  bootstrapEmperorHome,
  legacyDefaultStateRoot,
  loadBundledToolCatalog,
  localSecretKeyPath,
  runPendingDataMigrations,
  sealerFromSecretStore,
  setCoreLogSink,
  type SecretSealer,
} from '@emperor/core/host-capabilities'
import { resolveLogLocation } from './logging/log-location'
import { createAppLog, logLevelOf, teeConsole } from './logging/app-log'
import { installProcessErrorHandlers } from './logging/process-errors'
import { startCrashReporting } from './logging/crash-reporting'
import { DiagnosticsBundles } from './diagnostics-bundle'
import {
  exportDiagnosticsBundle,
  registerDiagnosticsBundleIpc,
} from './diagnostics-bundle-ipc'
import { electronFrameworkBinary, readFuseStates } from './fuse-state'
import { registerHomeBackupIpc, type HomeBackupStore } from './home-backup-ipc'

import { offerMoveToApplications } from './app-location'
import { resolveConfig } from './config'
import {
  acquireStateDirectoryLock,
  StateDirectoryLockError,
  writeLockOwner,
  type StateDirectoryLock,
} from './state-directory-lock'
import { createLoadFailurePolicy } from './load-failure'
import { windowBackground } from './window-background'
import { createQuitCoordinator } from './quit-coordinator'
import { claimSingleInstance } from './single-instance'
import { trackedIpcMain } from './tracked-ipc'
import { resolveAppIconPath } from './icon'
import { preparePackagedRuntime, runtimeDefaultsRoot } from './runtime-root'
import {
  fitBoundsToDisplays,
  pickBounds,
  readBounds,
  type Bounds,
} from './window-bounds'
import {
  appAssetRequestAccess,
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
  resolveStaticAssetPath,
  withContentSecurityPolicy,
} from './protocol'
import { rendererContentSecurityPolicy } from '../shared/content-security-policy'
import { applicationMenuTemplate, menuRoles } from './app-menu'
import { defaultSessionPermission } from './renderer-permissions'
import { hardenSession } from './computer-use/session-hardening'
import { registerOpenPathIpc } from './open-path-ipc'
import { registerAppVersionIpc } from './app-version-ipc'
import { createQuarantine } from './quarantine'
import { executorVersionHostOptions, updateHostOptions } from './update-host'
import { registerRemoteImageIpc } from './remote-image-ipc'
import {
  createScreenshotCapture,
  registerScreenshotIpc,
} from './screenshot-ipc'
import { pluginAssetResponse } from './plugin-assets'
import {
  WORKSPACE_MEDIA_HOST,
  registerWorkspaceMediaIpc,
  workspaceMediaResponse,
} from './workspace-media'
import { createCoreHost } from './core-host'
import { CoreEventBridge, SessionEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import {
  PACKAGED_SMOKE_REFUSED_EXIT,
  packagedSmokeLaunch,
  runPackagedSmoke,
} from './packaged-smoke'
import { developmentRendererUrl, mainRendererUrl } from './renderer-url'
import { DEBUG_SWITCH_REFUSED_EXIT, refusedDebugSwitch } from './debug-switches'
import { verifyPackagedSeatbelt } from './packaged-seatbelt-smoke'
import {
  createPackagedSmokeAttachment,
  traversalHostSecret,
  verifyPackagedRenderer,
} from './packaged-renderer-smoke'
import { verifyWindowReopen } from './packaged-window-smoke'
import {
  runPackagedUpgradeSmoke,
  verifySessionShown,
} from './packaged-upgrade-smoke'
import {
  createTrustedRendererPolicy,
  type TrustedRendererPolicy,
} from './trusted-renderer'
import { linkDestination } from './link-routing'
import { mainWindowWebPreferences } from './window-security'
import { NodePtyHost } from './terminal-host'
import { TerminalEventBridge } from './terminal-event-bridge'
import { BrowserViewHost } from './browser-view'
import { BrowserPreferencesCache } from './browser-preferences-cache'
import { UserDownloads } from './user-downloads'
import {
  ImportError,
  importBrowserData,
  listImportSources,
} from './browser-import'
import { registerDesktopCapabilityIpc } from './desktop-capability-ipc'
import { PointerOverlay } from './computer-use/pointer-overlay'
import { pointerAllowed } from './computer-use/pointer-overlay-view'
import { createPreviewPointerRelay } from './computer-use/preview-pointer'
import { EmbeddedBrowserDriver } from './computer-use/embedded-browser-driver'
import { electronBrowserFactory } from './computer-use/electron-factory'
import { nativeImageCodec } from './computer-use/images'
import { DesktopComputerUsePort, hostPlatform } from './computer-use/port'
import { AgentPreview } from './computer-use/preview'
import { DesktopPreview, routedPreview } from './computer-use/desktop-preview'
import {
  BACKUP_EXTENSION,
  CredentialVault,
} from './computer-use/credential-vault'
import {
  backupFilePath,
  defaultBackupName,
  readBackupFile,
  writeBackupFile,
} from './computer-use/vault-backup-files'
import { MacosDesktopDriver } from './computer-use/macos-desktop-driver'
import {
  forgetHelperCopy,
  installPackagedMacosHelper,
  launchMacosHelper,
  macosHelperAppPath,
  packagedMacosAppIsAdHoc,
  signedIdentity,
} from './computer-use/macos-launcher'
import { verifyPackagedHelpers } from './packaged-helpers-smoke'
import { NmBridgeServer } from './computer-use/nm-bridge'
import {
  EncryptedFilePairingStore,
  localPairingCipher,
} from './computer-use/nm-bridge-store'
import { LocalSecretStore } from './local-secret-store'
import { ImportedCookieStore } from './computer-use/imported-cookies'
import { verifyPackagedSecrets } from './packaged-secrets-smoke'
import {
  NmManifestRegistrar,
  resolveNmHostPath,
} from './computer-use/nm-manifest'
import { ExternalBrowserDriver } from './computer-use/external-browser-driver'
import { ExternalDownloadLog } from './computer-use/external-downloads'
import {
  createBrowserExtensionService,
  type BrowserExtensionService,
} from './computer-use/browser-extension-installer'
import { registerCredentialVaultIpc } from './computer-use/credential-vault-ipc'
import {
  authenticateCredentialReveal,
  credentialAuthPath,
} from './computer-use/credential-auth'
import {
  createDesktopWebFetchClient,
  type ElectronRequestLike,
} from './public-http-client'
import { DictationService } from './dictation/dictation-service'
import { registerDictationIpc } from './dictation/dictation-ipc'
import {
  dictationHelperAppPath,
  dictationHelperExecutable,
  verifyDictationHelper,
} from './dictation/helper-location'
import {
  RECOVERY_ACTION_CHANNEL,
  createRecoveryActionHandler,
  createRecoveryHtml,
  recoveryPayload,
  recoveryWindowWebPreferences,
} from './recovery'
import {
  AGENT_PREVIEW_FRAME_CHANNEL,
  AGENT_PREVIEW_POINTER_CHANNEL,
  APP_MENU_COMMAND_CHANNEL,
  BROWSER_DOWNLOAD_EVENT_CHANNEL,
  BROWSER_PAIRING_REQUEST_CHANNEL,
  BROWSER_REVEAL_CHANNEL,
  PET_CLOSE_CHANNEL,
  PET_OPEN_CHANNEL,
  PET_RENDERER_BOOTSTRAP_CHANNEL,
  PET_RENDERER_CLOSE_CHANNEL,
  PET_STATUS_CHANNEL,
  PET_STATUS_REQUEST_CHANNEL,
  SELECT_DIRECTORY_CHANNEL,
  TERMINAL_SUBSCRIPTION_CHANNEL,
  type AppMenuCommand,
} from '../shared/ipc-contract'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
// SEC-04: a packaged app opens no DevTools endpoint (no fuse covers these).
const debugSwitch = refusedDebugSwitch({
  isPackaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
})
if (debugSwitch) {
  console.error(`refusing --${debugSwitch} in a packaged build`)
  app.exit(DEBUG_SWITCH_REFUSED_EXIT)
  process.exit(DEBUG_SWITCH_REFUSED_EXIT)
}
// Emperor keeps no secret in the macOS Keychain (local-secret-store.ts).
// Should Chromium itself reach for it, a mock keychain answers instead of a
// "Safe Storage" prompt. Extra insurance only; keychain-free.test.ts and the
// bundle audit hold the code to it.
app.commandLine.appendSwitch('use-mock-keychain')
let config = resolveConfig({ argv: mainArgv, env: process.env })
// REL-01: main.log, core.log (5 MB × 5, redacted) and Crashpad dumps in
// ~/Library/Logs/Emperor Agent; with EMPEROR_CONFIG_DIR in `<home>/logs`.
const logLocation = resolveLogLocation({
  stateRoot: config.stateRoot,
  stateRootSource: config.stateRootSource,
  homeDir: os.homedir(),
  platform: process.platform,
  // Only asked off macOS: getPath('logs') creates its default folder.
  ...(process.platform === 'darwin' ? {} : { systemLogs: app.getPath('logs') }),
})
app.setAppLogsPath(logLocation.dir)
const logLevel = logLevelOf(process.env.EMPEROR_LOG_LEVEL)
const mainLog = createAppLog({ file: logLocation.mainLog, level: logLevel })
const coreLog = createAppLog({ file: logLocation.coreLog, level: logLevel })
teeConsole(console, mainLog)
setCoreLogSink((line) => coreLog.write(line.level, line.msg, line.fields))
installProcessErrorHandlers({ process, log: mainLog })
const crashReporting = startCrashReporting({
  dir: logLocation.crashDumps,
  app,
  crashReporter,
})
mainLog.info(`Emperor Agent ${app.getVersion()} starting`, {
  packaged: app.isPackaged,
  electron: process.versions.electron,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  stateRootSource: config.stateRootSource,
  logs: logLocation.source,
})
if (!crashReporting.ok)
  mainLog.warn('crash reporting unavailable', { error: crashReporting.error })
app.on('render-process-gone', (_event, contents, details) => {
  mainLog.warn('renderer process gone', {
    kind: contents === mainWindow?.webContents ? 'main' : contents.getType(),
    reason: details.reason,
    exitCode: details.exitCode,
  })
})
app.on('child-process-gone', (_event, details) => {
  mainLog.warn('child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name ?? details.serviceName ?? null,
  })
})
// MAIN-28: the smoke runs only on a disposable state root under the system
// temp directory; otherwise exit before anything reads or writes state.
const smokeLaunch = packagedSmokeLaunch(process.argv, {
  stateRoot: config.stateRoot,
})
if (smokeLaunch.kind === 'refuse') {
  console.error(`packaged smoke refused: ${smokeLaunch.reason}`)
  app.exit(PACKAGED_SMOKE_REFUSED_EXIT)
  process.exit(PACKAGED_SMOKE_REFUSED_EXIT)
}
const packagedSmoke =
  smokeLaunch.kind === 'run'
    ? { receiptPath: smokeLaunch.receiptPath, scenario: smokeLaunch.scenario }
    : null
// Chromium's profile (Local Storage, caches) stays with the smoke's state,
// not in the installed app's Application Support folder.
if (packagedSmoke)
  app.setPath('userData', path.join(config.stateRoot, 'electron-user-data'))
// A second launch on the same data directory hands over and quits.
const primaryInstance = claimSingleInstance(
  app,
  {
    stateRootSource: config.stateRootSource,
    packagedSmoke: Boolean(packagedSmoke),
  },
  () => showMainWindow(),
)
if (!primaryInstance) app.quit()
let legacyRuntimeRoot = config.runtimeRoot
let packagedRuntimeRevision = ''
const rendererRoot = path.join(mainDir, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: mainDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

let coreApi: CoreApi | null = null
let stateDirectoryLock: StateDirectoryLock | null = null
let startupTask: Promise<void> = Promise.resolve()
let runtimeStarting = false
let shutdownRequested = false
let closeCoreTask: Promise<void> | null = null
// Keep ownership through every quit/exit hook; only actual OS process exit
// releases the connection, including a hard crash.
const coreEventBridge = new CoreEventBridge()
const sessionEventBridge = new SessionEventBridge()
/** IPC handlers the current startup attempt registered (removed before a retry). */
let startupIpc: ReturnType<typeof trackedIpcMain> | null = null
const terminalEventBridge = new TerminalEventBridge()
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let recoveryWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let petLastError: string | null = null
let browserViewHost: BrowserViewHost | null = null
// 设置 › 浏览器, read synchronously (will-download, link routing, history):
// loaded once Core is up, then kept current by its change events.
const browserPreferences = new BrowserPreferencesCache()
coreEventBridge.listen((event) => browserPreferences.observe(event))
// The user's own downloads in the built-in browser (设置 › 浏览器 › 下载).
let userDownloads: UserDownloads | null = null
// Computer Use drivers are created here; the kernel owns all execution.
let computerUsePort: DesktopComputerUsePort | null = null
let embeddedBrowser: EmbeddedBrowserDriver | null = null
let nativeDesktop: MacosDesktopDriver | null = null
let nmBridge: NmBridgeServer | null = null
let externalBrowser: ExternalBrowserDriver | null = null
/** Emperor's downloads in the user's own Chrome/Edge (RV-09). */
let externalDownloads: ExternalDownloadLog | null = null
// 设置 › 电脑操作 › Chrome 和 Edge: ~/.emperor/browser-extension.
let browserExtension: BrowserExtensionService | null = null
let credentialVault: CredentialVault | null = null
/** Cookies imported into persistent profiles, sealed (SEC-10). */
let importedCookies: ImportedCookieStore | null = null
/** Core seals model keys and MCP tokens with the vault's local key (SEC-06). */
let coreSecretSealer: SecretSealer | null = null
let dictation: DictationService | null = null
let agentPreview: AgentPreview | null = null
let desktopPreview: DesktopPreview | null = null
let pointerOverlay: PointerOverlay | null = null
const mainLoadFailures = createLoadFailurePolicy()
const trustedRendererPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://bundle/index.html',
  developmentUrl: developmentRendererUrl({
    isPackaged: app.isPackaged,
    env: process.env,
  }),
  mainWebContents: () => mainWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  openLink: (url) => openUserLink(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})
// SEC-05: the app://bundle header; index.html carries the same meta.
const RENDERER_CSP = rendererContentSecurityPolicy()
const HELP_URL = 'https://github.com/TheSyart/emperor-agent#readme'
// Core's web_fetch and the remote markdown images (UI-38) share one public
// HTTP client: no cookies, no local or private addresses.
const webFetchClient = createDesktopWebFetchClient({
  resolveProxy: async (url) => await app.resolveProxy(url),
  request: (options) => net.request(options) as unknown as ElectronRequestLike,
})
const trustedPetPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://pet/renderer.html',
  mainWebContents: () => petWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})

/**
 * What shows that the Agent works: the helper's capture streams give macOS
 * its purple sharing mark, the conversation shows a read-only preview, and
 * the virtual pointer follows desktop actions. Emperor draws no "正在操控"
 * bar of its own (2026-09-29) and has no emergency stop (2026-10-01): the
 * master switch and stopping the conversation end the work. Here the
 * on-screen pointer goes away once it may no longer show.
 */
function syncControlIndicators(): void {
  const view = coreApi?.host.computerUse?.service.statusView() ?? null
  if (!pointerAllowed(view)) pointerOverlay?.clear()
}

/**
 * The Agent's pointer on the conversation preview: where a desktop or
 * built-in browser action lands, for a target the Agent controls. The
 * on-screen pointer above still shows only where the window is in front.
 */
const relayPreviewPointer = createPreviewPointerRelay({
  status: () => coreApi?.host.computerUse?.service.statusView() ?? null,
  send: (pointer) => {
    const contents = mainWindow?.webContents
    if (contents && !contents.isDestroyed())
      contents.send(AGENT_PREVIEW_POINTER_CHANNEL, pointer)
  },
})

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
      // Range requests for the Files pane's videos (BUG-05: workspace-media).
      stream: true,
    },
  },
])

ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async (event) => {
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

// REL-05: the renderer's app version is app.getVersion(), never the preload's.
registerAppVersionIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  version: () => app.getVersion(),
})

// MAIN-27: only folders Core vouches for, never a renderer-chosen path.
registerOpenPathIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  sources: {
    emperorHome: () => config.stateRoot,
    // KRN-01: the renderer names the session; main keeps no focus.
    sessionProject: (sessionId) =>
      coreApi?.host.projectRootForSession(sessionId) ?? null,
    skillFolder: (name, sessionId) => {
      try {
        return coreApi?.skills.get(name, { sessionId }).root ?? null
      } catch {
        return null
      }
    },
    invalidSkillPaths: (sessionId) =>
      coreApi?.skills.list({ sessionId }).invalid.map((item) => item.path) ??
      [],
    logsFolder: () => logLocation.dir,
  },
  isDirectory: (target) => {
    try {
      return fs.statSync(target).isDirectory()
    } catch {
      return false
    }
  },
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
})

// 「用默认应用打开」 / 「在访达中显示」 for a file Core granted the Files pane,
// by address (BUG-05, BUG-10).
registerWorkspaceMediaIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  lookup: (token) => coreApi?.files.mediaGrant(token) ?? null,
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
})

// REL-01 导出诊断包: staged in a private temp folder, listed for the user,
// then zipped where they choose (设置 › 诊断 and the recovery page).
const diagnosticsBundles = new DiagnosticsBundles({
  sources: {
    logDir: logLocation.dir,
    crashDumps: logLocation.crashDumps,
    stateRoot: config.stateRoot,
    homeDir: os.homedir(),
    app: () => diagnosticsAppFacts(),
    core: () => (coreApi ? coreApi.diagnostics.get({ sessionId: null }) : null),
    system: () => diagnosticsSystemFacts(),
  },
  tempDir: app.getPath('temp'),
})
registerDiagnosticsBundleIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  bundles: diagnosticsBundles,
  chooseTarget: (name) => chooseBundleTarget(name, mainWindow),
  reveal: (target) => shell.showItemInFolder(target),
  homeDir: os.homedir(),
})

// REL-03 设置 › 高级 › 存储 › 备份与恢复: its code loads on first use.
let homeBackups: HomeBackupStore | null = null
registerHomeBackupIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  backups: async () => {
    if (homeBackups) return homeBackups
    const { HomeBackups } = await import('./home-backup')
    homeBackups = new HomeBackups({
      home: config.stateRoot,
      tempDir: app.getPath('temp'),
      appVersion: app.getVersion(),
      vault: () => credentialVault,
      sealer: () => coreSecretSealer,
    })
    return homeBackups
  },
  chooseTarget: (name) => chooseHomeBackupFile(name, 'save'),
  chooseBackup: () => chooseHomeBackupFile('', 'open'),
  reveal: (target) => shell.showItemInFolder(target),
  relaunch: () => {
    app.relaunch()
    app.quit()
  },
  homeDir: os.homedir(),
})

// UI-38: a remote markdown image the user clicked, fetched here.
registerRemoteImageIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  client: webFetchClient,
})

// UI-S04: the composer's + › 截图 — the system's region capture, read back.
registerScreenshotIpc({
  ipcMain,
  authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
  capture: createScreenshotCapture({
    platform: process.platform,
    screenAccess: () =>
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'unknown',
    makeTempDir: () =>
      fs.promises.mkdtemp(path.join(app.getPath('temp'), 'emperor-shot-')),
    run: (args) =>
      new Promise<void>((resolve, reject) => {
        // Esc ends it with no file; it never needs more than a few minutes.
        execFile(
          '/usr/sbin/screencapture',
          args,
          { timeout: 300_000 },
          (error) => {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
              reject(error)
            else resolve()
          },
        )
      }),
    readFile: (target) => fs.promises.readFile(target),
    removeDir: (target) =>
      fs.promises.rm(target, { recursive: true, force: true }),
  }),
  windowOf: (event) => {
    const sender = (event as { sender?: WebContents }).sender
    return sender ? BrowserWindow.fromWebContents(sender) : null
  },
})

ipcMain.handle(PET_OPEN_CHANNEL, async (event) => {
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

ipcMain.handle(PET_CLOSE_CHANNEL, async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  petLastError = null
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.close()
  }
  return petStatus()
})

ipcMain.handle(PET_STATUS_REQUEST_CHANNEL, async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  return petStatus()
})

ipcMain.handle(PET_RENDERER_BOOTSTRAP_CHANNEL, async (event) => {
  trustedPetPolicy.authorizeIpc(event)
  return { event: { type: 'connection', online: runtimeReady } }
})

ipcMain.handle(PET_RENDERER_CLOSE_CHANNEL, async (event) => {
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
  const computerUseRoot = path.join(config.stateRoot, 'computer-use')
  // Passwords and browser pairings are sealed with Emperor's own key, never
  // the Keychain. While vault entries still need a key that has gone, no new
  // key is made over them; Settings offers 清空 instead.
  const localSecrets = new LocalSecretStore({
    keyPath: localSecretKeyPath(config.stateRoot),
    sealedDataExists: () => credentialVault?.hasSealedData ?? true,
  })
  // The same key (and the same lost-key rule) seals the API keys in
  // model_config.json and MCP tokens in mcp_config.json.
  coreSecretSealer = sealerFromSecretStore(localSecrets)
  // Never throws (SEC-09): a damaged or newer vault.json is kept as it is
  // and only Computer Use credentials are unavailable until Settings fixes it.
  credentialVault = new CredentialVault({
    path: path.join(computerUseRoot, 'vault.json'),
    storage: localSecrets,
  })
  if (credentialVault.problem)
    console.warn(`Credential vault unavailable: ${credentialVault.problem}`)
  // Cookies imported from Chrome/Edge are sealed with the same key and set
  // into a profile's session in memory only, never into Chromium's
  // `Cookies` (SEC-10); profile folders stay out of Time Machine.
  importedCookies = new ImportedCookieStore({
    profilesRoot: path.join(config.stateRoot, 'browser', 'profiles'),
    storage: localSecrets,
    sessionFromPath: (directory) => session.fromPath(directory),
  })
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: hostPlatform(process.platform),
    profilesRoot: path.join(config.stateRoot, 'browser', 'profiles'),
    profileStorage: importedCookies,
    downloadsRoot: path.join(config.stateRoot, 'browser', 'downloads'),
    credentials: credentialVault,
    credentialVisibility: (targetId, visible) =>
      agentPreview?.setSensitive(targetId, visible),
    previewPointer: relayPreviewPointer,
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
      // Socket and helper copies follow EMPEROR_CONFIG_DIR (MAIN-25).
      stateRoot: config.stateRoot,
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
        previewPointer: relayPreviewPointer,
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
        path.join(computerUseRoot, 'browser-pairings', 'pairings.json'),
        localPairingCipher(localSecrets),
      ),
    })
    externalDownloads = new ExternalDownloadLog(
      path.join(config.stateRoot, 'computer-use', 'external-downloads.json'),
    )
    externalBrowser = new ExternalBrowserDriver(nmBridge, 'macos', {
      downloads: externalDownloads,
    })
    browserExtension = createBrowserExtensionService({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: path.resolve(mainDir, '..', '..'),
      stateRoot: config.stateRoot,
      homeDir: userInfo().homedir,
      bridge: nmBridge,
    })
    // An extension asked to pair: the renderer shows 电脑操作 › Chrome 和
    // Edge for the code; the Dock icon bounces, focus is not taken.
    nmBridge.subscribe((event) => {
      if (event.type !== 'pairing' || event.request.displayed) return
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed())
        contents.send(BROWSER_PAIRING_REQUEST_CHANNEL)
      app.dock?.bounce('informational')
    })
  }
  computerUsePort = new DesktopComputerUsePort({
    platform: process.platform,
    embeddedBrowser: () => driver,
    externalBrowser: () => externalBrowser,
    credentials: () => credentialVault,
    desktop: () => nativeDesktop,
    indicate: () => queueMicrotask(syncControlIndicators),
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

/**
 * Undo a failed startup before 重试 (MAIN-12): stop the Chrome bridge,
 * the drivers and Core it started, and drop the IPC handlers it
 * registered, so the next attempt starts clean instead of leaking a
 * second Computer Use host or failing on duplicate handlers.
 */
async function resetFailedStartup(): Promise<void> {
  await closeCoreHost().catch((error) =>
    console.error(`failed to close the previous startup: ${errMessage(error)}`),
  )
  closeCoreTask = null
  startupIpc?.removeAll()
  startupIpc = null
}

function closeCoreHost(): Promise<void> {
  closeCoreTask ??= closeCoreResources()
  return closeCoreTask
}

async function closeCoreResources(): Promise<void> {
  pointerOverlay?.dispose()
  pointerOverlay = null
  browserViewHost?.close()
  browserViewHost = null
  closeAgentBrowser(true)
  const nativeShutdown = nativeDesktop?.shutdown().catch(() => undefined)
  externalBrowser?.dispose()
  externalBrowser = null
  browserExtension?.dispose()
  browserExtension = null
  const bridgeShutdown = nmBridge?.stop().catch(() => undefined)
  nmBridge = null
  sessionEventBridge.dispose()
  const current = coreApi
  coreApi = null
  await Promise.all([nativeShutdown, bridgeShutdown, current?.close()])
}

/** Bring a running packaged Emperor forward ('' on success). */
function activateApp(appPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [appPath], { timeout: 10_000 }, (error) =>
      resolve(error ? errMessage(error) : ''),
    )
  })
}

function fail(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  app.quit()
}

async function showBootstrapRecovery(error: unknown): Promise<void> {
  runtimeReady = false
  // The recovery page shows only a code; main.log keeps the whole cause
  // (stack and every `cause`), and the page offers 打开日志 (REL-01).
  mainLog.error('Emperor startup failed', { error })
  if (coreApi) await coreApi.close().catch(() => {})
  coreApi = null
  if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.close()
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  const legacyHome =
    config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null
  const payload = recoveryPayload(error, {
    emperorHome: config.stateRoot,
    legacyHome,
    logFile: logLocation.mainLog,
  })
  const ownerApp =
    payload.canSwitch && error instanceof StateDirectoryLockError
      ? (error.owner?.appPath ?? null)
      : null
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
      await resetFailedStartup()
      const restarting = startRuntime()
      if (!win.isDestroyed()) win.close()
      recoveryWindow = null
      await restarting
    },
    openPath: (target) => shell.openPath(target),
    exit: () => app.quit(),
    ...(ownerApp ? { switchToOwner: () => activateApp(ownerApp) } : {}),
    openLogs: () =>
      shell.openPath(
        fs.existsSync(logLocation.mainLog)
          ? logLocation.mainLog
          : logLocation.dir,
      ),
    diagnostics: {
      prepare: async () => {
        const bundle = await diagnosticsBundles.prepare()
        bundleNames.set(bundle.id, bundle.name)
        return bundle
      },
      export: (id) =>
        exportDiagnosticsBundle({
          bundles: diagnosticsBundles,
          id,
          chooseTarget: (name) => chooseBundleTarget(name, win),
          homeDir: os.homedir(),
          name: bundleNames.get(id),
        }),
      discard: (id) => diagnosticsBundles.discard(id),
    },
  })
  const bundleNames = new Map<string, string>()
  ipcMain.handle(
    RECOVERY_ACTION_CHANNEL,
    async (event, action: unknown, bundle: unknown) =>
      handle(event.sender.id, action, bundle),
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

/** The save dialog for a diagnostics bundle (Desktop by default). */
async function chooseBundleTarget(
  name: string,
  owner: BrowserWindow | null,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: '导出诊断包',
    buttonLabel: '导出',
    defaultPath: path.join(app.getPath('desktop'), name),
    filters: [{ name: 'Zip', extensions: ['zip'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const result =
    owner && !owner.isDestroyed()
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** Main's own save / open dialog for a `.emperor-backup.zip` (REL-03). */
async function chooseHomeBackupFile(
  name: string,
  kind: 'save' | 'open',
): Promise<string | null> {
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const filters = [{ name: 'Emperor 备份', extensions: ['zip'] }]
  if (kind === 'open') {
    const options: OpenDialogOptions = {
      title: '从备份恢复',
      buttonLabel: '选择',
      defaultPath: app.getPath('documents'),
      filters,
      properties: ['openFile'],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
  const options: SaveDialogOptions = {
    title: '导出备份',
    buttonLabel: '导出',
    defaultPath: path.join(app.getPath('documents'), name),
    filters,
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

/** At most `ms` for one status probe of the bundle; its error otherwise. */
async function boundedProbe<T>(
  task: Promise<T> | undefined,
  ms = 3_000,
): Promise<T | { error: string } | null> {
  if (!task) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.catch((error: unknown) => ({ error: errMessage(error) })),
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ error: 'timed out' }), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** app.json of the diagnostics bundle: versions, fuses, helpers, extension. */
async function diagnosticsAppFacts(): Promise<Record<string, unknown>> {
  const [fuses, helper, dictationStatus, extension] = await Promise.all([
    readFuseStates(electronFrameworkBinary(process.execPath)),
    boundedProbe(nativeDesktop?.status()),
    boundedProbe(dictation?.status()),
    boundedProbe(browserExtension?.status()),
  ])
  const voice =
    dictationStatus && !('error' in dictationStatus)
      ? {
          available: dictationStatus.available,
          reason: dictationStatus.reason ?? null,
          engine: dictationStatus.engine,
          permissions: dictationStatus.permissions,
        }
      : dictationStatus
  return {
    app: {
      name: 'Emperor Agent',
      version: app.getVersion(),
      packaged: app.isPackaged,
      runtimeRevision: packagedRuntimeRevision || 'development',
      runtimeReady,
      stateRootSource: config.stateRootSource,
      uptimeSeconds: Math.round(process.uptime()),
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    logs: {
      location: logLocation.source,
      level: logLevel,
      crashReporting: crashReporting.ok ? 'local' : crashReporting.error,
    },
    fuses: fuses ?? 'unavailable',
    helper,
    dictation: voice,
    extension,
    chromeBridge: nmBridge
      ? { reason: nmBridge.unavailableReason ?? null }
      : null,
  }
}

/** system.json of the diagnostics bundle. */
function diagnosticsSystemFacts(): Record<string, unknown> {
  const cpus = os.cpus()
  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    kernel: os.release(),
    translated: app.runningUnderARM64Translation,
    cpu: { model: cpus[0]?.model ?? '', count: cpus.length },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    locale: app.getLocale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    uptimeSeconds: Math.round(os.uptime()),
  }
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
    if (url.host === 'plugin-assets')
      return pluginAssetResponse(
        url,
        (input) => coreApi?.plugins.logo(input) ?? null,
      )
    if (url.host === WORKSPACE_MEDIA_HOST)
      return workspaceMediaResponse(
        request,
        (token) => coreApi?.files.mediaGrant(token) ?? null,
      )
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
      return withContentSecurityPolicy(
        await net.fetch(
          pathToFileURL(
            resolveAssetPath(url.pathname, rendererRoot),
          ).toString(),
        ),
        RENDERER_CSP,
      )
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
  // The Vite dev server only when not packaged (MAIN-10, renderer-url.ts).
  mainWindow.loadURL(
    mainRendererUrl({ isPackaged: app.isPackaged, env: process.env }),
  )
}

/**
 * No link moves a window off its document (UI-4): will-navigate passes only
 * a reload of the current page, subframes never navigate, popups are denied
 * (http(s) opens as a user link), and untrusted redirects stop.
 */
function secureWindowNavigation(
  win: BrowserWindow,
  policy: TrustedRendererPolicy,
): void {
  const contents = win.webContents
  contents.on('will-navigate', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl, contents.getURL()),
  )
  contents.on('will-frame-navigate', (details) =>
    policy.handleFrameNavigation(details),
  )
  contents.on('will-redirect', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  contents.setWindowOpenHandler((details) => policy.handleWindowOpen(details))
}

/**
 * MAIN-3: the default session (main window, pet, pointer overlay, recovery)
 * grants nothing — no microphone, camera, screen, notifications or devices,
 * no downloads — except clipboard writes from the main window's own page.
 */
function secureDefaultSession(): void {
  hardenSession(session.defaultSession, {
    allowPermission: defaultSessionPermission({
      isTrustedMainRenderer: (contents) => {
        const main = mainWindow
        return (
          main !== null &&
          !main.isDestroyed() &&
          contents === main.webContents &&
          trustedRendererPolicy.isTrustedUrl(main.webContents.getURL())
        )
      },
    }),
  })
}

/** MAIN-20: Emperor's own menu; packaged builds: no reload, no DevTools. */
function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({
        appName: 'Emperor Agent',
        packaged: app.isPackaged,
        platform: process.platform,
        openSettings: () => sendMenuCommand('open-settings'),
        openHelp: () => {
          void shell.openExternal(HELP_URL).catch(() => undefined)
        },
      }),
    ),
  )
}

function sendMenuCommand(command: AppMenuCommand): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!runtimeReady) return
    createWindow()
    mainWindow?.webContents.once('did-finish-load', () =>
      mainWindow?.webContents.send(APP_MENU_COMMAND_CHANNEL, command),
    )
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.webContents.send(APP_MENU_COMMAND_CHANNEL, command)
}

/** Restored bounds that land on a display connected now (MAIN-19). */
function onScreen(
  bounds: Bounds,
  min?: { width: number; height: number },
): Bounds {
  return fitBoundsToDisplays(
    bounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
    min,
  )
}

/** The packaged smoke's hidden window with the main window's preferences. */
function smokeWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: mainWindowWebPreferences(mainDir, {
      packaged: app.isPackaged,
    }),
  })
  mainWindow = win
  secureWindowNavigation(win, trustedRendererPolicy)
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

/** Resolves with the window once its page finished loading (smoke). */
function windowLoaded(win: BrowserWindow): Promise<BrowserWindow> {
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(win))
  })
}

/** Closes a window and resolves on its `closed` event (smoke). */
function windowClosed(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve()
    win.once('closed', () => resolve())
    win.close()
  })
}

function createWindow(): void {
  const boundsPath = mainBoundsPath()
  mainWindow = new BrowserWindow({
    ...onScreen(readBounds(boundsPath)),
    title: 'Emperor Agent',
    icon: appIconPath,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    show: false,
    webPreferences: mainWindowWebPreferences(mainDir, {
      packaged: app.isPackaged,
    }),
  })
  pointerOverlay ??= new PointerOverlay()
  syncControlIndicators()
  browserViewHost = new BrowserViewHost(mainWindow, Date.now, {
    // 设置 › 浏览器 › 浏览历史; unknown (Core not ready) counts as on.
    historyEnabled: () => browserPreferences.current.history,
    onDownload: (event, item, contents) => {
      if (userDownloads) userDownloads.offer(event, item, contents)
      else event.preventDefault()
    },
    forgetDownloads: () => userDownloads?.clear(),
  })
  // A reloaded or crashed renderer lost the BrowserPane that placed the native
  // view; drop it so it cannot linger above the new UI.
  // 00 §12: while the UI is gone nobody can watch the Agent, so its targets
  // pause (they stay open) and carry on once the window has loaded again.
  const uiDisconnected = (): void => {
    browserViewHost?.close()
    agentPreview?.stopAll()
    desktopPreview?.stopAll()
    coreApi?.host.computerUse?.service.pauseForUiDisconnect()
  }
  mainWindow.webContents.on('did-navigate', uiDisconnected)
  mainWindow.webContents.on('render-process-gone', uiDisconnected)
  mainWindow.webContents.on('did-finish-load', () => {
    coreApi?.host.computerUse?.service.resumeAfterUiReconnect()
  })
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
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      const action = mainLoadFailures.onFail(errorCode, isMainFrame)
      if (action === 'ignore') return
      console.error(`did-fail-load: ${errorCode} ${errorDescription}`)
      if (action === 'retry') loadRenderer()
      else fail('页面加载失败', `无法加载前端（${errorDescription}）。`)
    },
  )
  mainWindow.webContents.on('did-finish-load', () =>
    mainLoadFailures.onLoaded(),
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
    ...onScreen(readPetBounds(boundsPath), { width: 300, height: 340 }),
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
      devTools: !app.isPackaged,
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
  // Right-click: reopen the main window (closed while the pet stays) or hide the pet.
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '关闭桌宠', click: () => win.isDestroyed() || win.close() },
    ]).popup({ window: win })
  })
}

async function startup(): Promise<void> {
  if (shutdownRequested) return
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
    // Acquire before migrations, credentials, Core recovery or any state writer.
    if (!stateDirectoryLock) {
      stateDirectoryLock = acquireStateDirectoryLock(
        config.stateRoot,
        config.stateRootSource === 'default' ? legacyDefaultStateRoot() : null,
      )
      // Tells a blocked second App who holds the directory (FIX-07).
      writeLockOwner(stateDirectoryLock, {
        pid: process.pid,
        version: app.getVersion(),
        startedAt: Date.now(),
        packaged: app.isPackaged,
        appPath: app.isPackaged
          ? path.resolve(process.execPath, '..', '..', '..')
          : null,
      })
    }
    // REL-03: a restore 设置 › 存储 scheduled is applied before anything
    // opens the home; then the data migrations the home is behind on.
    const restored = await applyPendingHomeRestore(config.stateRoot).catch(
      (error: unknown) => {
        console.warn(`Restore from backup failed: ${String(error)}`)
        return null
      },
    )
    if (restored) console.info(`Restore from backup ${restored.status}`)
    prepareMainRuntime()
    await runPendingDataMigrations(config.stateRoot, {
      appVersion: app.getVersion(),
    })
    createComputerUseHost()
    userDownloads = createUserDownloads()
    // The Chrome/Edge bridge is optional: if another Emperor holds its
    // socket, start without it and let the driver report why.
    if (nmBridge && !(await nmBridge.startOrDegrade()))
      console.warn(
        `Chrome/Edge connection unavailable: ${nmBridge.unavailableReason ?? 'unknown'}`,
      )
    // Upgrade the extension folder in the background; never block startup.
    void browserExtension?.start()
    startupIpc = trackedIpcMain(ipcMain)
    coreApi = await createCoreHost({
      root: config.runtimeRoot,
      ipcMain: startupIpc,
      eventBridge: coreEventBridge,
      sessionEventBridge,
      authorizeIpc: (event) => trustedRendererPolicy.authorizeIpc(event),
      coreOptions: {
        // Development builds check every model request against its session
        // log (KRN-13); production leaves it to EMPEROR_ASSERT_INVARIANT=1.
        assertRequestInvariant:
          !app.isPackaged || process.env.EMPEROR_ASSERT_INVARIANT === '1',
        verifyGeneratedImage: (bytes) => {
          const image = nativeImage.createFromBuffer(Buffer.from(bytes))
          const size = image.getSize()
          return (
            !image.isEmpty() &&
            size.width > 0 &&
            size.height > 0 &&
            size.width * size.height <= 16 * 1024 * 1024
          )
        },
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
              computerUseEnabledChanged: () => syncControlIndicators(),
            }
          : {}),
        terminalHost: new NodePtyHost(),
        terminalEventSink: terminalEventBridge.sink(),
        webFetchClient,
        logDirectory: logLocation.dir,
        // REL-02 检查更新: Core checks and downloads; main gives the net,
        // Finder, Downloads and whether checks may run here.
        updates: updateHostOptions({
          env: process.env,
          isPackaged: app.isPackaged,
          packagedSmoke: Boolean(packagedSmoke),
          arch: process.arch,
          electronVersion: process.versions.electron ?? '',
          downloadsDir: app.getPath('downloads'),
          tempDir: app.getPath('temp'),
          reveal: (target) => shell.showItemInFolder(target),
          markQuarantine: createQuarantine(),
          request: (options) =>
            net.request(options) as unknown as ElectronRequestLike,
          log: (line) => console.info(line),
        }),
        // AGT-13 子智能体 › 版本: npm's public version numbers.
        executorVersions: executorVersionHostOptions({
          env: process.env,
          isPackaged: app.isPackaged,
          packagedSmoke: Boolean(packagedSmoke),
          request: (options) =>
            net.request(options) as unknown as ElectronRequestLike,
          log: (line) => console.info(line),
        }),
        ...(coreSecretSealer ? { secretSealer: coreSecretSealer } : {}),
        // Dev-build e2e only: external executors look for sign-ins in this
        // folder instead of ~/.claude and never run the login shell (AGT-02);
        // the harness's fake claude comes first on PATH, so 登录 Claude Code
        // runs its `auth login` (AGT-12, FIX-11).
        ...(!app.isPackaged && process.env.EMPEROR_E2E_EXECUTOR_HOME
          ? {
              executorHome: {
                home: process.env.EMPEROR_E2E_EXECUTOR_HOME,
                environment: { PATH: process.env.PATH ?? '' },
                loginShell: { read: async () => ({}) },
              },
            }
          : {}),
      },
    })
    const core = coreApi
    await browserPreferences.load(() => core.browser.preferences())
    syncControlIndicators()
    startDownloadRetention()
    registerDesktopCapabilityIpc({
      ipcMain: startupIpc,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      ...(nativeDesktop ? { macHelper: nativeDesktop } : {}),
      ...(nmBridge ? { browserPairings: nmBridge } : {}),
      externalAttachedCount: () => externalBrowser?.listAttached().length ?? 0,
      ...(browserExtension ? { browserExtension } : {}),
      externalAttachedTabs: () => externalBrowser?.listAttached() ?? [],
      browser: {
        openUrl: (input) => requireBrowserViewHost().openUrl(input),
        setBounds: (bounds) => browserViewHost?.setBounds(bounds),
        action: (action) => browserViewHost?.action(action),
        close: () => browserViewHost?.close(),
        history: async () => (await browserViewHost?.history()) ?? [],
        openHistory: (id) => requireBrowserViewHost().openHistory(id),
        clearData: () => requireBrowserViewHost().clearData(),
      },
      references: {
        revealPath: (input) => {
          if (!coreApi) throw new Error('core not ready')
          return coreApi.references.revealPath(input)
        },
      },
      showItemInFolder: (target) => shell.showItemInFolder(target),
      openExternal: (url) => shell.openExternal(url),
      openLink: (url) => openUserLink(url),
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
        // The inbox, then what the Agent downloaded in Chrome/Edge (RV-09).
        list: () =>
          [
            ...(embeddedBrowser?.downloads?.list() ?? []),
            ...(externalDownloads?.list() ?? []),
          ].sort((a, b) => b.time - a.time),
      },
      userDownloads: {
        list: () => userDownloads?.list() ?? [],
        open: async (id) =>
          (await userDownloads?.open(id)) ?? '找不到这个下载文件',
        reveal: (id) => userDownloads?.reveal(id) ?? false,
        remove: (id) => userDownloads?.remove(id) ?? false,
        chooseFolder: async () => {
          const options: OpenDialogOptions = {
            title: '选择下载位置',
            buttonLabel: '选择',
            defaultPath: userDownloads?.folder() ?? app.getPath('downloads'),
            properties: ['openDirectory', 'createDirectory'],
          }
          const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options)
          if (result.canceled || !result.filePaths.length) return null
          return result.filePaths[0] ?? null
        },
      },
      browserImport: {
        // Reading and decrypting stay in main; the renderer sees only counts.
        sources: () => listImportSources(),
        run: async (request) => {
          try {
            return await importBrowserData(request, {
              ...(credentialVault ? { vault: credentialVault } : {}),
              // Only an existing persistent profile may receive cookies;
              // checked before anything is read or written.
              profileExists: (profileId) =>
                coreApi?.host.computerUse?.service
                  .listProfiles()
                  .some(
                    (profile) =>
                      profile.profileId === profileId &&
                      profile.kind === 'persistent',
                  ) ?? false,
              // Cookies go into the chosen persistent profile's session in
              // memory and are sealed in its imported-cookies.el1; Chromium's
              // `Cookies` never holds them (SEC-10).
              cookieSink: (profileId) => {
                if (!importedCookies)
                  throw new Error('browser profiles are not available')
                return importedCookies.sinkFor(profileId)
              },
              log: (message, counts) =>
                console.info(`[browser-import] ${message}`, counts),
            })
          } catch (error) {
            return {
              ok: false,
              reason: error instanceof ImportError ? error.reason : 'internal',
            }
          }
        },
      },
    })
    dictation = createDictationService()
    registerDictationIpc({
      ipcMain,
      authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
      service: dictation,
      ...(process.platform === 'darwin'
        ? { openExternal: (url: string) => shell.openExternal(url) }
        : {}),
    })
    if (credentialVault)
      registerCredentialVaultIpc({
        ipcMain,
        authorize: (event) => trustedRendererPolicy.authorizeIpc(event),
        vault: credentialVault,
        // 导出 / 导入凭据备份: paths come only from these dialogs.
        backupFiles: {
          chooseExportPath: async () => {
            const options: SaveDialogOptions = {
              title: '导出凭据备份',
              buttonLabel: '导出',
              defaultPath: path.join(
                app.getPath('documents'),
                defaultBackupName(new Date()),
              ),
              filters: [
                { name: 'Emperor 凭据备份', extensions: [BACKUP_EXTENSION] },
              ],
              properties: ['createDirectory', 'showOverwriteConfirmation'],
            }
            const result = mainWindow
              ? await dialog.showSaveDialog(mainWindow, options)
              : await dialog.showSaveDialog(options)
            return result.canceled || !result.filePath
              ? null
              : backupFilePath(result.filePath)
          },
          chooseImportPath: async () => {
            const options: OpenDialogOptions = {
              title: '选择凭据备份',
              buttonLabel: '选择',
              filters: [
                { name: 'Emperor 凭据备份', extensions: [BACKUP_EXTENSION] },
              ],
              properties: ['openFile'],
            }
            const result = mainWindow
              ? await dialog.showOpenDialog(mainWindow, options)
              : await dialog.showOpenDialog(options)
            return result.canceled ? null : (result.filePaths[0] ?? null)
          },
          read: readBackupFile,
          write: writeBackupFile,
        },
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
      // SEC-04: the helpers start and answer under the hardened runtime; the
      // check also shuts the Computer Use helper down and forgets its copy.
      const smokeHelpers = () => {
        const helperSource = macosHelperAppPath({
          packaged: true,
          resourcesPath: process.resourcesPath,
        })
        return verifyPackagedHelpers({
          computerHelperStatus: async () => {
            if (!nativeDesktop)
              throw new Error('the Computer Use helper is missing')
            return await nativeDesktop.status()
          },
          // The copy the driver launched: it lives in the Emperor Home
          // (EMPEROR_CONFIG_DIR), so forget() reaches its registration.
          installedComputerHelper: () =>
            installPackagedMacosHelper(helperSource, {
              stateRoot: config.stateRoot,
            }),
          identity: (target) => signedIdentity(target),
          release: async () => {
            await nativeDesktop?.shutdown()
          },
          forget: (installed) => forgetHelperCopy(installed),
          dictationStatus: () =>
            (dictation ?? createDictationService()).status(),
        })
      }
      if (packagedSmoke.scenario === 'upgrade') {
        // REL-04: started on a copy of the 0.1.0-preview.4 fixture home.
        await runPackagedUpgradeSmoke({
          core,
          receiptPath: packagedSmoke.receiptPath,
          showSession: (sessionId, text) =>
            verifySessionShown({
              createWindow: smokeWindow,
              sessionId,
              text,
            }),
        })
        if (process.platform === 'darwin') await smokeHelpers()
      } else {
        // Local key and master password round trips, with no Keychain.
        await verifyPackagedSecrets(config.stateRoot)
        const attachment = await createPackagedSmokeAttachment(config.stateRoot)
        await runPackagedSmoke({
          core,
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
            const webPreferences = mainWindowWebPreferences(mainDir, {
              packaged: app.isPackaged,
            })
            return verifyPackagedRenderer({
              createWindow: () => {
                const win = new BrowserWindow({
                  show: false,
                  backgroundColor: windowBackground(
                    nativeTheme.shouldUseDarkColors,
                  ),
                  webPreferences,
                })
                mainWindow = win
                secureWindowNavigation(win, trustedRendererPolicy)
                return win
              },
              // The URL the real main window loads, from the same helper.
              rendererUrl: mainRendererUrl({
                isPackaged: app.isPackaged,
                env: process.env,
              }),
              // REL-05: the renderer must read this over the bridge.
              appVersion: app.getVersion(),
              attachmentUrl: attachment.url,
              attachmentContent: attachment.content,
              // REL-04: what an app:// request outside its root would return.
              traversal: {
                canary: attachment.traversalCanary,
                hostSecret: traversalHostSecret(),
              },
              chromiumSandboxDisabledForTest:
                process.argv.includes('--no-sandbox'),
              webPreferences,
              security: {
                expectedCsp: RENDERER_CSP,
                applicationMenuRoles: () =>
                  menuRoles(Menu.getApplicationMenu()),
              },
              releaseWindow: () => {
                mainWindow = null
              },
            })
          },
          // REL-04: the real main window closes and comes back (activate).
          verifyWindows: () =>
            verifyWindowReopen({
              open: async () => {
                runtimeReady = true
                createWindow()
                return await windowLoaded(mainWindow!)
              },
              close: (win) => windowClosed(win as BrowserWindow),
              reopen: async () => {
                app.emit('activate')
                if (!mainWindow) throw new Error('activate opened no window')
                return await windowLoaded(mainWindow)
              },
              current: () => mainWindow,
            }),
          verifyHelpers: smokeHelpers,
        })
      }
      // REL-04: leave the way Cmd+Q does (before-quit flushes and closes
      // Core, will-quit writes "quit" to main.log); the runner checks it.
      mainLog.info('packaged smoke finished; quitting')
      app.quit()
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
  mainLog.info('Core ready; opening the main window')

  createWindow()
}

function startRuntime(): Promise<void> {
  runtimeStarting = true
  startupTask = startup().finally(() => {
    runtimeStarting = false
  })
  return startupTask
}

app.whenReady().then(() => {
  if (!primaryInstance) return
  secureDefaultSession()
  installApplicationMenu()
  return startRuntime()
})

app.on('activate', () => {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show()
    return
  }
  // The pet keeps a window open: count the main window itself (MAIN-17).
  showMainWindow()
})

/** Bring the main window back, creating it when it was closed. */
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (runtimeReady) createWindow()
}

app.on('window-all-closed', () => {
  if (packagedSmoke || runtimeStarting) return
  app.quit()
})

/** Core as it was when quitting began (closeCoreResources clears coreApi). */
let quittingCore: CoreApi | null = null

const coordinateQuit = createQuitCoordinator({
  flush: () => {
    quittingCore = coreApi
    coreApi?.flushAll()
  },
  // Shutdown overran 10s: kill child process trees and terminals now (FIX-07, AGT-06).
  onTimeout: () => quittingCore?.forceStop(),
  close: async () => {
    await startupTask
    await closeCoreHost()
  },
  onError: (error) =>
    console.error(`failed to close CoreApi: ${errMessage(error)}`),
  quit: () => app.quit(),
})

app.on('before-quit', (event) => {
  shutdownRequested = true
  ipcMain.removeHandler(RECOVERY_ACTION_CHANNEL)
  coordinateQuit(event)
})

process.once('SIGTERM', () => app.quit())
process.once('SIGINT', () => app.quit())

app.on('will-quit', () => {
  dictation?.dispose()
  diagnosticsBundles.disposeAll()
  mainLog.info('quit')
})

/**
 * The user's own downloads (设置 › 浏览器 › 下载): the folder and the ask
 * choice come from the preference copy, the history lives in
 * `~/.emperor/browser/user-downloads.json`, and the 浏览器 pane hears about
 * each download.
 */
function createUserDownloads(): UserDownloads {
  return new UserDownloads({
    recordPath: path.join(config.stateRoot, 'browser', 'user-downloads.json'),
    preferences: () => browserPreferences.current,
    systemDownloads: () => app.getPath('downloads'),
    notify: (view) => {
      const contents = mainWindow?.webContents
      if (contents && !contents.isDestroyed())
        contents.send(BROWSER_DOWNLOAD_EVENT_CHANNEL, view)
    },
    openPath: (target) => shell.openPath(target),
    showItemInFolder: (target) => shell.showItemInFolder(target),
  })
}

/**
 * Editor dictation (VO-01): the macOS helper runs as Emperor's own child,
 * from inside the app when packaged (its signature checked first).
 */
function createDictationService(): DictationService {
  const helperApp =
    process.platform === 'darwin'
      ? dictationHelperAppPath({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          desktopRoot: path.resolve(mainDir, '..', '..'),
        })
      : null
  return new DictationService({
    executable: () => {
      if (!helperApp) return null
      const executable = dictationHelperExecutable(helperApp)
      return fs.existsSync(executable) ? executable : null
    },
    ...(app.isPackaged && helperApp
      ? {
          verify: async () =>
            await verifyDictationHelper(
              helperApp,
              path.resolve(fs.realpathSync(process.execPath), '..', '..', '..'),
            ),
        }
      : {}),
  })
}

/**
 * A web link the user clicked in Emperor's UI (chat links, a window the main
 * window tried to open): the system or the built-in browser, as 设置 ›
 * 浏览器 says for web links and for addresses of this machine
 * (link-routing.ts). The built-in browser shows it in the 浏览器 pane.
 */
async function openUserLink(
  url: string,
): Promise<'builtin' | 'system' | 'refused'> {
  const destination = linkDestination(url, browserPreferences.current)
  if (destination === 'builtin' && mainWindow && !mainWindow.isDestroyed()) {
    await requireBrowserViewHost().openUrl({ url })
    mainWindow.webContents.send(BROWSER_REVEAL_CHANNEL, { url })
    return 'builtin'
  }
  if (destination === 'system') {
    await shell.openExternal(url)
    return 'system'
  }
  return 'refused'
}

function requireBrowserViewHost(): BrowserViewHost {
  if (!browserViewHost) throw new Error('browser host is not ready')
  return browserViewHost
}
