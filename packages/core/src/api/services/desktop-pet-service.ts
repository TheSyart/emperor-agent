import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn as childSpawn, type SpawnOptions } from 'node:child_process'
import { join, resolve } from 'node:path'
import { loadLocalConfig, saveLocalConfig } from '../../config/local-config'

type Dict = Record<string, any>
type SpawnedProcess = { pid?: number; unref?: () => void }
type SpawnFn = (command: string, args: string[], opts: SpawnOptions) => SpawnedProcess

export interface CoreDesktopPetServiceDeps {
  stateRoot?: string | null
  assertMutation?: (area: string, action: string) => void
  spawn?: SpawnFn
  processAlive?: (pid: number) => boolean
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
}

export class CoreDesktopPetService {
  readonly runtimeRoot: string
  readonly stateRoot: string
  private readonly deps: CoreDesktopPetServiceDeps

  constructor(root: string, deps: CoreDesktopPetServiceDeps = {}) {
    this.runtimeRoot = resolve(root)
    this.stateRoot = resolve(deps.stateRoot ?? root)
    this.deps = deps
  }

  async get(): Promise<Dict> {
    const config = await loadLocalConfig(this.stateRoot)
    const pid = this.readPid()
    const running = Boolean(pid && this.processAlive(pid))
    return {
      enabled: config.desktopPet.enabled,
      autoStartWithWebui: config.desktopPet.autoStartWithWebui,
      running,
      pid: running ? pid : null,
      lastError: this.readState().lastError ?? null,
      installCommand: this.installCommand(),
      managedBy: 'CoreApi',
      available: Boolean(this.packagedCommand().length || existsSync(this.electronBinary())),
    }
  }

  setEnabled(enabled: boolean): Promise<Dict> {
    this.deps.assertMutation?.('desktop pet', 'toggle')
    return this.setEnabledInner(enabled)
  }

  private async setEnabledInner(enabled: boolean): Promise<Dict> {
    const config = await loadLocalConfig(this.stateRoot)
    await saveLocalConfig(this.stateRoot, {
      ...config,
      desktopPet: { ...config.desktopPet, enabled: Boolean(enabled) },
    })
    if (enabled) return this.start()
    this.stop()
    return this.get()
  }

  private async start(): Promise<Dict> {
    const existing = await this.get()
    if (existing.running) return existing
    this.clearStalePid()

    const packaged = this.packagedCommand()
    let cmdBase: string[]
    if (packaged.length) {
      cmdBase = packaged
    } else {
      const electron = this.electronBinary()
      if (!existsSync(electron)) return this.fail(`Electron dependency missing. Run \`${this.installCommand()}\` before starting the desktop pet.`)
      if (!existsSync(join(this.runtimeRoot, 'desktop-pet', 'main.js'))) return this.fail('desktop-pet/main.js is missing.')
      cmdBase = [electron, join(this.runtimeRoot, 'desktop-pet')]
    }

    const cmd = [...cmdBase, '--root', this.runtimeRoot]
    try {
      const spawned = this.spawn()(cmd[0]!, cmd.slice(1), {
        cwd: join(this.runtimeRoot, 'desktop-pet'),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EMPEROR_AGENT_ROOT: this.runtimeRoot, EMPEROR_CONFIG_DIR: this.stateRoot },
      })
      spawned.unref?.()
      this.writePid(spawned.pid ?? 0, cmd)
      this.writeState({ lastError: null, startedAt: Date.now() / 1000 })
      return this.get()
    } catch (error) {
      return this.fail(`Failed to start desktop pet: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private stop(): void {
    const pid = this.readPid()
    if (pid && this.processAlive(pid)) {
      try { process.kill(pid, 'SIGTERM') } catch { /* process already gone */ }
    }
    rmSync(join(this.runtimeDir(), 'pid.json'), { force: true })
    this.writeState({ lastError: null, stoppedAt: Date.now() / 1000 })
  }

  private async fail(message: string): Promise<Dict> {
    this.writeState({ lastError: message, lastErrorAt: Date.now() / 1000 })
    return this.get()
  }

  private runtimeDir(): string {
    return join(this.stateRoot, 'memory', 'desktop_pet')
  }

  private electronBinary(): string {
    return join(this.runtimeRoot, 'desktop-pet', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  }

  private installCommand(): string {
    return this.packagedCommand().length ? 'bundled with Emperor Agent.app' : `cd ${join(this.runtimeRoot, 'desktop-pet')} && npm install`
  }

  private packagedCommand(): string[] {
    const raw = String(this.deps.env?.EMPEROR_DESKTOP_PET_CMD ?? process.env.EMPEROR_DESKTOP_PET_CMD ?? '').trim()
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string' && item) ? parsed : []
    } catch {
      return raw.split(/\s+/).filter(Boolean)
    }
  }

  private readPid(): number | null {
    try {
      const data = JSON.parse(readFileSync(join(this.runtimeDir(), 'pid.json'), 'utf8'))
      const pid = Number(data.pid)
      return Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : null
    } catch {
      return null
    }
  }

  private writePid(pid: number, cmd: string[]): void {
    if (!pid) return
    const dir = this.runtimeDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pid.json'), JSON.stringify({ pid, cmd, updatedAt: Date.now() / 1000 }, null, 2) + '\n', 'utf8')
  }

  private readState(): Dict {
    try {
      const data = JSON.parse(readFileSync(join(this.runtimeDir(), 'state.json'), 'utf8'))
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch {
      return {}
    }
  }

  private writeState(updates: Dict): void {
    const dir = this.runtimeDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...this.readState(), ...updates }, null, 2) + '\n', 'utf8')
  }

  private clearStalePid(): void {
    const pid = this.readPid()
    if (pid && this.processAlive(pid)) return
    rmSync(join(this.runtimeDir(), 'pid.json'), { force: true })
  }

  private processAlive(pid: number): boolean {
    if (this.deps.processAlive) return this.deps.processAlive(pid)
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private spawn(): SpawnFn {
    return this.deps.spawn ?? ((command, args, opts) => childSpawn(command, args, opts))
  }
}
