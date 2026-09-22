import { nowTs } from '../util/time'
import type { TokenTracker } from '../memory/token-tracker'
import type { LlmClient } from '../llm/client'
import { createUserMessage } from '../llm/message'
import {
  decisionPrompt,
  parseWatchlistDecision,
  WatchlistDecision,
} from './models'
import { WatchlistStore } from './store'

export type WatchlistDecisionFn = (
  content: string,
  items: string[],
) => WatchlistDecision | Promise<WatchlistDecision>

export class WatchlistService {
  readonly root: string
  readonly store: WatchlistStore
  decider: WatchlistDecisionFn | null
  llm: LlmClient | null
  tokenTracker: TokenTracker | null

  constructor(
    root: string,
    opts: {
      decider?: WatchlistDecisionFn | null
      llm?: LlmClient | null
      tokenTracker?: TokenTracker | null
    } = {},
  ) {
    this.root = root
    this.store = new WatchlistStore(root)
    this.decider = opts.decider ?? null
    this.llm = opts.llm ?? null
    this.tokenTracker = opts.tokenTracker ?? null
  }

  payload(): Record<string, unknown> {
    return this.store.payload()
  }
  read(): string {
    return this.store.read()
  }
  write(content: string): Record<string, unknown> {
    this.store.write(content)
    return this.payload()
  }

  async check(signal?: AbortSignal): Promise<WatchlistDecision> {
    const content = this.store.read()
    const items = this.store.activeItems()
    if (!items.length) {
      const decision = WatchlistDecision.skip('watchlist has no active items')
      this.store.writeDecision(decision)
      return decision
    }
    const decision = this.decider
      ? await this.decider(content, items)
      : await this.decideWithModel(content, items, signal)
    decision.checked_at = decision.checked_at || nowTs()
    this.store.writeDecision(decision)
    return decision
  }

  private async decideWithModel(
    content: string,
    items: string[],
    signal?: AbortSignal,
  ): Promise<WatchlistDecision> {
    if (!this.llm || this.llm.activeRoute() === undefined)
      return WatchlistDecision.skip('model is unavailable')
    const prompt = decisionPrompt({ content, items })
    const system = prompt
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const user = prompt
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n')
    const base = this.llm.defaultCallConfig()
    const result = await this.llm.complete({
      provider: base.provider,
      model: base.model,
      system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: 1200,
      temperature: 0,
      purpose: 'auxiliary',
      ...(signal === undefined ? {} : { signal }),
    })
    const usage = result.usage
    if (usage)
      this.tokenTracker?.record(
        base.model,
        {
          prompt_tokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
          completion_tokens: usage.outputTokens,
          prompt_cache_hit_tokens: usage.cacheReadTokens ?? 0,
        },
        {
          provider: base.provider,
          usageType: 'watchlist_check',
          modelEntryId: base.provider,
        },
      )
    const decision = parseWatchlistDecision(result.text || '')
    decision.model = base.model
    decision.provider = base.provider
    decision.model_entry_id = base.provider
    return decision
  }
}
