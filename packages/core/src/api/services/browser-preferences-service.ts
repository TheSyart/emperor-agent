import { resolve } from 'node:path'
import {
  loadLocalConfig,
  normalizeBrowserPreferences,
  saveLocalConfig,
  type BrowserPreferences,
} from '../../config/local-config'

export interface CoreBrowserPreferencesServiceDeps {
  stateRoot?: string | null
  assertMutation?: (area: string, action: string) => void
  /** Main routes links and the pane follows the switch: tell them. */
  changed?: (preferences: BrowserPreferences) => void
}

/**
 * The user's own built-in browser (`settings.json` › `browser`): where a
 * clicked web link and a link to this machine open, the address bar, the
 * temporary history and where the user's downloads go. Not the Agent's
 * browser (computer use).
 */
export class CoreBrowserPreferencesService {
  readonly stateRoot: string

  constructor(
    root: string,
    private readonly deps: CoreBrowserPreferencesServiceDeps = {},
  ) {
    this.stateRoot = resolve(deps.stateRoot ?? root)
  }

  async get(): Promise<BrowserPreferences> {
    return (await loadLocalConfig(this.stateRoot)).browser
  }

  async update(
    change: Partial<BrowserPreferences>,
  ): Promise<BrowserPreferences> {
    this.deps.assertMutation?.('browser', 'settings')
    const config = await loadLocalConfig(this.stateRoot)
    const browser = normalizeBrowserPreferences({
      ...config.browser,
      ...change,
    })
    await saveLocalConfig(this.stateRoot, { ...config, browser })
    this.deps.changed?.(browser)
    return browser
  }
}
