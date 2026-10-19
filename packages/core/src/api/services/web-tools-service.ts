import { resolve } from 'node:path'
import {
  loadLocalConfig,
  normalizeWebToolPreferences,
  saveLocalConfig,
  type WebToolPreferences,
} from '../../config/local-config'
import type { WebToolsStatus } from '../../harness/host/web-tools'

export interface CoreWebToolsServiceDeps {
  stateRoot?: string | null
  /** The host's network tools: what it offers, and the live switches. */
  tools: {
    status(): WebToolsStatus
    update(settings: WebToolPreferences): void
  }
  assertMutation?: (area: string, action: string) => void
  /** The tool list changed: tell every window. */
  changed?: (status: WebToolsStatus) => void
}

/**
 * 设置 › 高级 › 网络工具 (`settings.json` › `webTools`): the `web_fetch` and
 * `web_search` switches. A change is saved, then applied to the running
 * host, so the next request and 能力 › 工具 both follow it.
 */
export class CoreWebToolsService {
  readonly stateRoot: string

  constructor(
    root: string,
    private readonly deps: CoreWebToolsServiceDeps,
  ) {
    this.stateRoot = resolve(deps.stateRoot ?? root)
  }

  status(): WebToolsStatus {
    return this.deps.tools.status()
  }

  async update(change: Partial<WebToolPreferences>): Promise<WebToolsStatus> {
    this.deps.assertMutation?.('tools', 'network settings')
    const config = await loadLocalConfig(this.stateRoot)
    const webTools = normalizeWebToolPreferences({
      ...config.webTools,
      ...change,
    })
    await saveLocalConfig(this.stateRoot, { ...config, webTools })
    this.deps.tools.update(webTools)
    const status = this.status()
    this.deps.changed?.(status)
    return status
  }
}
