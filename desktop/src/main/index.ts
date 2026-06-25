import { app, BrowserWindow, dialog, ipcMain, protocol, net, type OpenDialogOptions, type Rectangle } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveConfig } from './config'
import { buildBackendCommand } from './backend-command'
import { probeBackend, waitForBackend } from './health'
import { resolveAppIconPath } from './icon'
import { planStartup, planShutdown } from './lifecycle'
import {
  bundledBackendPath as resolveBundledBackendPath,
  initializePackagedRuntime,
  packagedRuntimeRoot,
  runtimeDefaultsRoot,
} from './runtime-root'
import { readBounds, pickBounds } from './window-bounds'
import { resolveAssetPath } from './protocol'

const mainArgv = process.argv.slice(2)
const petWindowMode = mainArgv.includes('--pet-window')
let config = resolveConfig({ argv: mainArgv, env: process.env })
const rendererRoot = path.join(__dirname, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: __dirname,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

// Packaged-only defense-in-depth: a per-launch token shared with the spawned backend
// (env) and the renderer (preload arg). Empty in dev so electron-vite dev stays token-free.
const authToken = app.isPackaged && !petWindowMode ? randomUUID() : ''

let backendChild: ChildProcess | null = null
let ownsBackend = false
let backendReady = false
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

function reclaimBackend(): void {
  const { shouldKill } = planShutdown({ ownsBackend, child: backendChild })
  if (!shouldKill || !backendChild) return
  const child = backendChild
  backendChild = null
  try {
    child.kill('SIGTERM')
    // Hard-stop fallback if SIGTERM is ignored within the grace period.
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Process already gone; nothing to reclaim.
      }
    }, 2000)
  } catch {
    // If killing fails the OS reaps the child when we exit anyway.
  }
}

function fail(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  reclaimBackend()
  app.quit()
}

function spawnBackend(): ChildProcess {
  const { command, args } = buildBackendCommand({
    config,
    env: process.env,
    bundledBackendPath: app.isPackaged ? resolveBundledBackendPath(process.resourcesPath, process.platform) : '',
  })
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (authToken) env.EMPEROR_WEBUI_TOKEN = authToken
  if (app.isPackaged) env.EMPEROR_DESKTOP_PET_CMD = JSON.stringify([process.execPath, '--pet-window'])
  const child = spawn(command, args, { cwd: config.root, stdio: 'inherit', env })

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'ENOENT') {
      fail(
        '无法启动后端',
        '未找到 emperor-agent 命令。请在仓库根目录执行 `pip install -e .`，或设置环境变量 EMPEROR_BACKEND_CMD 指向可用的启动命令。',
      )
    } else {
      fail('无法启动后端', `启动后端进程失败：${errMessage(err)}`)
    }
  })

  child.on('exit', (code) => {
    // Exit before readiness means startup failed; after readiness it means the
    // user/OS stopped the backend and the app should follow.
    if (!backendReady && code !== 0 && code !== null) {
      fail('后端进程退出', `后端在就绪前以退出码 ${code} 结束。请检查 emperor-agent web 是否能在仓库根目录正常运行。`)
    }
  })

  return child
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
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
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // In dev mode (isPackaged==false) the Vite dev server proxies /api
      // and /ws, so the renderer should use same-origin relative paths.
      // In prod mode (app://) the preload injects the absolute backend URL.
      additionalArguments: app.isPackaged
        ? [`--backend-url=${config.backendBaseUrl}`, `--backend-token=${authToken}`]
        : [],
    },
  })

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

  loadRenderer()
}

function petRendererRoot(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'desktop-pet')
  return path.resolve(__dirname, '..', '..', '..', 'desktop-pet')
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
    (app.isPackaged ? packagedRuntimeRoot(app.getPath('userData')) : path.resolve(__dirname, '..', '..', '..'))
  const webuiUrl = argValue(mainArgv, '--webui-url') || process.env.EMPEROR_WEBUI_URL || 'http://127.0.0.1:8765'
  const assetBaseUrl = pathToFileURL(path.join(root, 'assets', 'desktop-pet', 'clawd-tank') + path.sep).href
  const backendToken = argValue(mainArgv, '--backend-token') || process.env.EMPEROR_WEBUI_TOKEN || ''
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
        `--emperor-webui-url=${webuiUrl}`,
        `--emperor-asset-base-url=${assetBaseUrl}`,
        `--emperor-backend-token=${backendToken}`,
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

  const alreadyHealthy = await probeBackend(config.backendBaseUrl)
  const plan = planStartup({ alreadyHealthy })
  ownsBackend = plan.ownsBackend

  if (plan.action === 'spawn') {
    backendChild = spawnBackend()
  }

  try {
    await waitForBackend(config.backendBaseUrl)
  } catch (err) {
    fail('后端未就绪', errMessage(err))
    return
  }
  backendReady = true

  createWindow()
}

app.whenReady().then(startup)

app.on('activate', () => {
  if (petWindowMode) {
    if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0 && backendReady) createWindow()
})

app.on('window-all-closed', () => {
  if (petWindowMode) {
    app.quit()
    return
  }
  reclaimBackend()
  app.quit()
})

app.on('before-quit', reclaimBackend)
