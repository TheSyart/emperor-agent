import { resolve } from 'node:path'
import {
  defaultGroupPreferences,
  loadLocalConfig,
  normalizeGroupPreferences,
  saveLocalConfig,
  type GroupPreferences,
} from '../../config/local-config'

/**
 * 设置 › 群聊 (GRP-08, D14; `settings.json` › `groups`): the collaboration
 * a new group starts with and whether its loop guard is on. Read once and
 * kept, so the group store can take them synchronously when it creates a
 * group (`current()`); a group keeps the settings it was made with.
 */
export class CoreGroupDefaultsService {
  readonly stateRoot: string
  private cached: GroupPreferences | null = null

  constructor(root: string, deps: { stateRoot?: string | null } = {}) {
    this.stateRoot = resolve(deps.stateRoot ?? root)
  }

  async get(): Promise<GroupPreferences> {
    if (this.cached === null)
      this.cached = (await loadLocalConfig(this.stateRoot)).groups
    return { ...this.cached }
  }

  /** What the last read or save gave; the built-in defaults before either. */
  current(): GroupPreferences {
    return { ...(this.cached ?? defaultGroupPreferences()) }
  }

  async update(change: Partial<GroupPreferences>): Promise<GroupPreferences> {
    if (
      change.collaboration !== undefined &&
      change.collaboration !== 'autonomous' &&
      change.collaboration !== 'moderated'
    )
      throw new Error(`未知的协作方式：${String(change.collaboration)}`)
    const config = await loadLocalConfig(this.stateRoot)
    const groups = normalizeGroupPreferences({ ...config.groups, ...change })
    await saveLocalConfig(this.stateRoot, { ...config, groups })
    this.cached = groups
    return { ...groups }
  }
}
