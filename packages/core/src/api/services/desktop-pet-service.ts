import { resolve } from 'node:path'
import { loadLocalConfig, saveLocalConfig } from '../../config/local-config'

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
    return {
      enabled: config.desktopPet.enabled,
      autoStartWithWebui: config.desktopPet.autoStartWithWebui,
      // Compatibility fields only. Electron main is the sole runtime window
      // authority and overlays its live status for renderer consumers.
      running: false,
      pid: null,
      lastError: null,
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
    return this.get()
  }
}
