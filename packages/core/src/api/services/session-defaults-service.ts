import { resolve } from 'node:path'
import {
  isSessionPermission,
  loadLocalConfig,
  saveLocalConfig,
  type SessionPermission,
} from '../../config/local-config'
import type { ViewScope } from '../../harness/host/scope'

export interface SessionDefaults {
  permission: SessionPermission
}

export interface CoreSessionDefaultsServiceDeps {
  stateRoot?: string | null
  /** The host's preset for sessions without a log yet (and drafts). */
  host: {
    readonly defaultPreset: string
    setDefaultPreset(preset: SessionPermission): void
  }
}

/**
 * 设置 › 常规 › 会话 › 新会话的权限 (`settings.json` › `sessions`): the
 * permission preset a session starts in. A change is saved, then applied to
 * the running host; sessions that already have a log keep their own.
 */
export class CoreSessionDefaultsService {
  readonly stateRoot: string

  constructor(
    root: string,
    private readonly deps: CoreSessionDefaultsServiceDeps,
  ) {
    this.stateRoot = resolve(deps.stateRoot ?? root)
  }

  get(): SessionDefaults {
    const preset = this.deps.host.defaultPreset
    return {
      permission: isSessionPermission(preset) ? preset : 'workspace-write',
    }
  }

  async update(
    change: { permission: SessionPermission },
    _view: ViewScope,
  ): Promise<SessionDefaults> {
    if (!isSessionPermission(change?.permission))
      throw new Error(`未知的权限：${String(change?.permission)}`)
    const config = await loadLocalConfig(this.stateRoot)
    await saveLocalConfig(this.stateRoot, {
      ...config,
      sessions: { defaultPermission: change.permission },
    })
    this.deps.host.setDefaultPreset(change.permission)
    return this.get()
  }
}
