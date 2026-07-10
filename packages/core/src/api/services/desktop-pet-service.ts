import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadLocalConfig, saveLocalConfig } from '../../config/local-config'

type Dict = Record<string, any>

export interface CoreDesktopPetServiceDeps {
  stateRoot?: string | null
  assertMutation?: (area: string, action: string) => void
}

export interface CoreDesktopPetPayload {
  enabled: boolean
  autoStartWithWebui: boolean
  running: boolean
  pid: number | null
  lastError: string | null
  installCommand: string
  managedBy: string
  available: boolean
  [key: string]: unknown
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

  async get(): Promise<CoreDesktopPetPayload> {
    const config = await loadLocalConfig(this.stateRoot)
    const state = this.readState()
    return {
      enabled: config.desktopPet.enabled,
      autoStartWithWebui: config.desktopPet.autoStartWithWebui,
      running: Boolean(state.running),
      pid: null,
      lastError: typeof state.lastError === 'string' ? state.lastError : null,
      installCommand: '',
      managedBy: 'Electron main process',
      available: true,
    }
  }

  setEnabled(enabled: boolean): Promise<CoreDesktopPetPayload> {
    this.deps.assertMutation?.('desktop pet', 'toggle')
    return this.setEnabledInner(enabled)
  }

  private async setEnabledInner(
    enabled: boolean,
  ): Promise<CoreDesktopPetPayload> {
    const config = await loadLocalConfig(this.stateRoot)
    await saveLocalConfig(this.stateRoot, {
      ...config,
      desktopPet: { ...config.desktopPet, enabled: Boolean(enabled) },
    })
    // Window open/close is handled by the renderer via main-process IPC
    // (emperor:pet:open / emperor:pet:close). This service only persists config.
    if (enabled) {
      this.writeState({
        running: true,
        lastError: null,
        startedAt: Date.now() / 1000,
      })
    } else {
      this.writeState({ running: false, stoppedAt: Date.now() / 1000 })
    }
    return this.get()
  }

  markStopped(): void {
    this.writeState({ running: false, stoppedAt: Date.now() / 1000 })
  }

  markError(message: string): void {
    this.writeState({
      running: false,
      lastError: message,
      lastErrorAt: Date.now() / 1000,
    })
  }

  private runtimeDir(): string {
    return join(this.stateRoot, 'memory', 'desktop_pet')
  }

  private readState(): Dict {
    try {
      const data = JSON.parse(
        readFileSync(join(this.runtimeDir(), 'state.json'), 'utf8'),
      )
      return data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : {}
    } catch {
      return {}
    }
  }

  private writeState(updates: Dict): void {
    const dir = this.runtimeDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ ...this.readState(), ...updates }, null, 2) + '\n',
      'utf8',
    )
  }
}
