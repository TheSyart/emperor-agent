import type { ViewScope } from '../../harness/host/scope'
import { resolve } from 'node:path'
import {
  loadLocalConfig,
  saveLocalConfig,
  type PetOutfit,
} from '../../config/local-config'

export interface CoreDesktopPetServiceDeps {
  stateRoot?: string | null
  /** The mutation guard of the session the caller shows (KRN-01). */
}

export interface CoreDesktopPetPayload {
  enabled: boolean
  autoStartWithWebui: boolean
  /** What the pet wears (BRD-04). */
  outfit: PetOutfit
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
      outfit: config.desktopPet.outfit,
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

  setEnabled(
    enabled: boolean,
    _view: ViewScope,
  ): Promise<CoreDesktopPetPayload> {
    return this.setEnabledInner(enabled)
  }

  /** Dress the pet (BRD-04); main tells an open pet window itself. */
  async setOutfit(
    outfit: PetOutfit,
    _view: ViewScope,
  ): Promise<CoreDesktopPetPayload> {
    const config = await loadLocalConfig(this.stateRoot)
    await saveLocalConfig(this.stateRoot, {
      ...config,
      desktopPet: { ...config.desktopPet, outfit },
    })
    return this.get()
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
