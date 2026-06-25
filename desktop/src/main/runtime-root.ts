import * as fs from 'node:fs'
import * as path from 'node:path'

export function packagedRuntimeRoot(userDataPath: string): string {
  return path.join(userDataPath, 'runtime')
}

export function runtimeDefaultsRoot(resourcesPath: string): string {
  return path.join(resourcesPath, 'runtime-defaults')
}

export function bundledBackendPath(resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  const exe = platform === 'win32' ? 'emperor-agent.exe' : 'emperor-agent'
  return path.join(resourcesPath, 'backend', exe)
}

export interface InitializeRuntimeOptions {
  root: string
  defaultsRoot: string
}

const DEFAULT_DIRS = ['templates', 'skills', 'assets']
const DEFAULT_FILES = ['model_config.example.json', 'mcp_config.example.json', '.env.example']

export function initializePackagedRuntime({ root, defaultsRoot }: InitializeRuntimeOptions): string[] {
  fs.mkdirSync(root, { recursive: true })
  const copied: string[] = []

  for (const dir of DEFAULT_DIRS) {
    const src = path.join(defaultsRoot, dir)
    const dest = path.join(root, dir)
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue
    fs.cpSync(src, dest, { recursive: true })
    copied.push(dir)
  }

  for (const file of DEFAULT_FILES) {
    const src = path.join(defaultsRoot, file)
    const dest = path.join(root, file)
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue
    fs.copyFileSync(src, dest)
    copied.push(file)
  }

  return copied
}
