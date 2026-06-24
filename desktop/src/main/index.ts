import { app, BrowserWindow, dialog, ipcMain, protocol, net, type OpenDialogOptions } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveConfig } from './config'
import { buildBackendCommand } from './backend-command'
import { probeBackend, waitForBackend } from './health'
import { resolveAppIconPath } from './icon'
import { planStartup, planShutdown } from './lifecycle'
import { readBounds, pickBounds } from './window-bounds'
import { resolveAssetPath } from './protocol'

const config = resolveConfig({ argv: process.argv.slice(2), env: process.env })
const boundsPath = path.join(config.root, 'memory', 'desktop', 'window.json')
const rendererRoot = path.join(__dirname, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: __dirname,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

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
  const { command, args } = buildBackendCommand({ config, env: process.env })
  const child = spawn(command, args, { cwd: config.root, stdio: 'inherit', env: process.env })

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
        ? [`--backend-url=${config.backendBaseUrl}`]
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

async function startup(): Promise<void> {
  app.setName('Emperor Agent')
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  if (process.platform === 'win32') app.setAppUserModelId('com.emperor.agent.desktop')

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
  if (BrowserWindow.getAllWindows().length === 0 && backendReady) createWindow()
})

app.on('window-all-closed', () => {
  reclaimBackend()
  app.quit()
})

app.on('before-quit', reclaimBackend)
