/**
 * The Agent's network tools and their switches (设置 › 高级 › 网络工具,
 * `settings.json` › `webTools`, KRN-08).
 *
 * - `web_fetch` exists when the host supplies a public HTTP client (the
 *   desktop app always does; headless ACP does not) and is on by default.
 * - `web_search` exists when the conversation's model runs on DeepSeek's
 *   official API (its Search API, with that route's key), or when a host
 *   injects its own backend.
 *
 * A switched-off or unavailable tool stays registered but invisible: it is
 * neither listed (能力 › 工具, the model's tool list) nor callable, and its
 * prompt section renders empty, so the prompt never names a tool the model
 * does not have.
 */

import type { WebToolPreferences } from '../../config/local-config'
import type { RouteSpec } from '../../llm/route'
import type { WebFetchClient } from '../../network/web-fetch-client'
import type { Agent } from '../agent/agent'
import type { SystemPromptAssembler } from '../prompt/assembler'
import { ToolError } from '../tools/definition'
import type { ToolRegistry } from '../tools/registry'
import {
  createDeepSeekSearchBackend,
  isDeepSeekOfficialRoute,
} from '../tools/builtin/deepseek-search'
import {
  createWebFetchTool,
  installWebFetchPromptSection,
} from '../tools/builtin/web-fetch'
import {
  createWebSearchTool,
  installWebSearchPromptSection,
  type WebSearchBackend,
} from '../tools/builtin/web-search'

/** Which service answers `web_search`. */
export type WebSearchProvider = 'deepseek' | 'host'

export interface WebToolsStatus {
  webFetch: { enabled: boolean; available: boolean }
  webSearch: {
    enabled: boolean
    /** The current model's provider offers search (or the host does). */
    available: boolean
    provider: WebSearchProvider | null
    /** The current model's display name, to explain an unavailable search. */
    model: string | null
  }
}

export interface WebToolsOptions {
  settings: WebToolPreferences
  fetchClient: WebFetchClient | null
  /** A host-supplied search backend: offered whatever the provider. */
  searchBackend: WebSearchBackend | null
  /** Test hook: the transport for DeepSeek's Search API. */
  searchFetch?: typeof fetch
  /** The route an agent's next request goes to (undefined: the active one). */
  routeOf(agent: Agent | undefined): RouteSpec | undefined
}

export class WebTools {
  private settings: WebToolPreferences

  constructor(private readonly options: WebToolsOptions) {
    this.settings = { ...options.settings }
  }

  install(tools: ToolRegistry, prompt: SystemPromptAssembler): void {
    const { fetchClient } = this.options
    if (fetchClient !== null)
      tools.register(createWebFetchTool(fetchClient), {
        visible: () => this.settings.webFetch,
      })
    installWebFetchPromptSection(
      prompt,
      (agent) => tools.get('web_fetch', agent) !== undefined,
    )
    tools.register(
      createWebSearchTool((context) => this.searchBackend(context.agent)),
      {
        visible: (agent) =>
          this.settings.webSearch && this.provider(agent) !== null,
      },
    )
    installWebSearchPromptSection(prompt, {
      visible: (agent) => tools.get('web_search', agent) !== undefined,
      fetchEnabled: (agent) => tools.get('web_fetch', agent) !== undefined,
    })
  }

  status(): WebToolsStatus {
    const provider = this.provider(undefined)
    return {
      webFetch: {
        enabled: this.settings.webFetch,
        available: this.options.fetchClient !== null,
      },
      webSearch: {
        enabled: this.settings.webSearch,
        available: provider !== null,
        provider,
        model: this.options.routeOf(undefined)?.displayName ?? null,
      },
    }
  }

  /** Apply saved switches (the caller persists them). */
  update(settings: WebToolPreferences): void {
    this.settings = { ...settings }
  }

  private provider(agent: Agent | undefined): WebSearchProvider | null {
    if (this.options.searchBackend !== null) return 'host'
    const route = this.options.routeOf(agent)
    return route !== undefined && isDeepSeekOfficialRoute(route)
      ? 'deepseek'
      : null
  }

  private searchBackend(agent: Agent | undefined): WebSearchBackend {
    if (this.options.searchBackend !== null) return this.options.searchBackend
    const route = this.options.routeOf(agent)
    if (route === undefined || !isDeepSeekOfficialRoute(route))
      throw new ToolError(
        'web_search is not available for the current model.',
        'WEB_SEARCH_UNAVAILABLE',
      )
    return createDeepSeekSearchBackend({
      apiKey: route.apiKey!,
      ...(this.options.searchFetch ? { fetch: this.options.searchFetch } : {}),
    })
  }
}
