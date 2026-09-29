/**
 * `LlmClient`: the process-wide model gateway. It owns the route table built
 * from `model_config.json`, resolves call configuration against a route's
 * capabilities, and normalizes adapter failures into terminal finish chunks
 * (ported from dsh-llm `LlmRuntime`, without the plugin registry).
 */

import type { LlmAdapter } from './adapter'
import { BlockAssembler } from './assembler'
import {
  contentHasImage,
  projectClearedImages,
  projectImagesForTextModel,
  type ImageResolver,
} from './content'
import { LlmError, normalizeLlmFailure } from './error'
import { deepFreeze } from './freeze'
import { createAssistantMessage, type AssistantMessage } from './message'
import {
  retryDelayMs,
  shouldRetry,
  type ResolvedRetryPolicy,
} from './retry-policy'
import type { RouteSpec } from './route'
import type {
  FinishReason,
  GenerateOptions,
  ImageAttachmentRef,
  LlmFailure,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
  TokenUsage,
} from './types'
import { abortableSleep } from '../util/timeout'
import {
  callConfigEquals,
  type LlmCallConfig,
  type LlmCallConfigAdapterDefaults,
} from './call-config'

export {
  callConfigEquals,
  type LlmCallConfig,
  type LlmCallConfigAdapterDefaults,
} from './call-config'

/** One model call whose config was resolved against its route. */
export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: { contextWindow: number }
  readonly inputModalities: readonly ModelModality[]
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Outcome of {@link LlmClient.complete}. */
export interface CompleteResult {
  message: AssistantMessage
  usage?: TokenUsage
  finish: FinishReason
  text: string
}

export interface LlmClientOptions {
  /** Chooses the adapter implementation for a route. */
  adapterFor: (route: RouteSpec) => LlmAdapter
  images?: ImageResolver
  /** False for an image whose stored bytes were cleared (sent as text). */
  imageAvailable?: (ref: ImageAttachmentRef) => boolean
  /**
   * Observes every request as dispatched to an adapter (after call-config
   * resolution). Tests install request invariants here; a throw fails the call.
   */
  onRequest?: (options: GenerateOptions) => void
}

export class LlmClient {
  private routes = new Map<string, RouteSpec>()
  private activeId: string | null = null

  constructor(private readonly options: LlmClientOptions) {}

  /** Replace the route table (called whenever model_config.json changes). */
  setRoutes(routes: readonly RouteSpec[], activeId: string | null): void {
    this.routes = new Map(routes.map((route) => [route.id, route]))
    this.activeId =
      activeId !== null && this.routes.has(activeId)
        ? activeId
        : (routes[0]?.id ?? null)
  }

  listRoutes(): RouteSpec[] {
    return [...this.routes.values()]
  }

  /** The active conversation route, if any is configured. */
  activeRoute(): RouteSpec | undefined {
    return this.activeId === null ? undefined : this.routes.get(this.activeId)
  }

  route(id: string): RouteSpec {
    const route = this.routes.get(id)
    if (!route)
      throw new LlmError(`no model route "${id}" is configured`, 'NO_ADAPTER')
    return route
  }

  /** Base request header config for the active route (or one named route). */
  defaultCallConfig(routeId?: string): LlmCallConfig {
    const route =
      routeId === undefined ? this.activeRoute() : this.route(routeId)
    if (!route)
      throw new LlmError(
        'no model is configured; add one on the Models page',
        'NO_ADAPTER',
      )
    return {
      provider: route.id,
      model: route.modelId,
      ...(route.temperature === undefined
        ? {}
        : { temperature: route.temperature }),
    }
  }

  resolveModelInfo(routeId: string): LlmResolvedModelInfo {
    const route = this.route(routeId)
    return {
      provider: route.id,
      id: route.modelId,
      name: route.displayName,
      inputModalities: route.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: route.contextWindow },
      defaultMaxTokens: route.maxTokens,
      ...(route.reasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: route.reasoningEfforts.map((id) => ({ id, name: id })),
              ...(route.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: route.defaultReasoningEffort }),
            },
          }),
    }
  }

  /** Validate controls against the route and materialize its defaults. */
  resolveCallConfig(config: LlmCallConfig): {
    config: LlmCallConfig
    adapterDefaults: LlmCallConfigAdapterDefaults
  } {
    const route = this.route(config.provider)
    const adapterDefaults: LlmCallConfigAdapterDefaults = {}
    let resolved: LlmCallConfig = { ...config }
    if (resolved.maxTokens === undefined) {
      resolved = { ...resolved, maxTokens: route.maxTokens }
      adapterDefaults.maxTokens = true
    }
    const requested = resolved.reasoningEffort
    if (route.reasoningEfforts.length === 0) {
      if (requested !== undefined) {
        throw new LlmError(
          `model "${route.modelId}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    } else {
      const effective = requested ?? route.defaultReasoningEffort
      if (effective !== undefined) {
        if (!route.reasoningEfforts.includes(effective)) {
          throw new LlmError(
            `model "${route.modelId}" does not support reasoning effort "${effective}"`,
            'UNSUPPORTED_REASONING_EFFORT',
          )
        }
        if (requested === undefined) {
          resolved = { ...resolved, reasoningEffort: effective }
          adapterDefaults.reasoningEffort = true
        }
      }
    }
    return { config: resolved, adapterDefaults }
  }

  /** Resolve one call and bind its dispatch to the current route. */
  prepareCall(config: LlmCallConfig): PreparedLlmCall {
    const route = this.route(config.provider)
    const { config: resolved, adapterDefaults } = this.resolveCallConfig(config)
    const frozen = deepFreeze(structuredClone(resolved))
    let dispatched = false
    return Object.freeze({
      config: frozen,
      retryPolicy: route.retryPolicy,
      context: { contextWindow: route.contextWindow },
      inputModalities: route.vision
        ? (['text', 'image'] as const)
        : (['text'] as const),
      adapterDefaults: deepFreeze(adapterDefaults),
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched)
          throw new LlmError(
            'a prepared LLM call can only be dispatched once',
            'INVALID_PREPARED_CALL',
          )
        if (!callConfigEquals(options, frozen)) {
          throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
          )
        }
        dispatched = true
        return this.adapterStream(route, options)
      },
    })
  }

  /**
   * Stream one call as raw chunks. Adapter failures (throws) become one
   * terminal `error`/`aborted` finish chunk; consumer failures stay thrown.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let route: RouteSpec
    try {
      route = this.route(options.provider)
    } catch (error: unknown) {
      return (async function* () {
        yield failureChunk(error, options.signal)
      })()
    }
    const { config } = this.resolveCallConfig(options)
    return this.adapterStream(route, { ...options, ...config })
  }

  private async *adapterStream(
    route: RouteSpec,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    this.options.onRequest?.(options)
    let iterator: AsyncIterator<StreamChunk>
    try {
      const hasImages = options.messages.some((message) =>
        contentHasImage(message.content),
      )
      const available = this.options.imageAvailable
      const projected = !hasImages
        ? options
        : !route.vision
          ? {
              ...options,
              messages: projectImagesForTextModel(options.messages),
            }
          : available !== undefined
            ? {
                ...options,
                messages: projectClearedImages(options.messages, available),
              }
            : options
      const adapter = this.options.adapterFor(route)
      const stream = adapter.stream(route, projected, {
        ...(this.options.images === undefined
          ? {}
          : { images: this.options.images }),
      })
      iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
      yield failureChunk(error, options.signal)
      return
    }
    let completed = false
    try {
      while (true) {
        let item: IteratorResult<StreamChunk>
        try {
          item = await iterator.next()
        } catch (error: unknown) {
          completed = true
          yield failureChunk(error, options.signal)
          return
        }
        if (item.done) {
          completed = true
          return
        }
        yield item.value
      }
    } finally {
      if (!completed) await iterator.return?.()
    }
  }

  /**
   * One-shot auxiliary completion (titles, compaction summaries, memory):
   * assembles the stream and applies the route retry policy.
   */
  async complete(options: GenerateOptions): Promise<CompleteResult> {
    const policy = this.route(options.provider).retryPolicy
    let retry = 0
    while (true) {
      const assembler = new BlockAssembler()
      for await (const chunk of this.stream(options)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        retry += 1
        if (
          finish.kind === 'error' &&
          shouldRetry(policy, finish.failure, retry) &&
          !options.signal?.aborted
        ) {
          await abortableSleep(
            retryDelayMs(policy, retry, finish.failure),
            options.signal,
          )
          continue
        }
        throw new LlmError(finish.failure.message, finish.failure.code, {
          ...(finish.failure.status === undefined
            ? {}
            : { status: finish.failure.status }),
        })
      }
      const blocks = assembler.blocks()
      const message = createAssistantMessage({
        content: blocks,
        source: { provider: options.provider, model: options.model },
      })
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('')
      return {
        message,
        finish,
        text,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      }
    }
  }
}

/** Convert one adapter throw into the stream protocol's terminal outcome. */
export function failureChunk(
  error: unknown,
  signal?: AbortSignal,
): StreamChunk {
  const failure: LlmFailure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason:
      signal?.aborted || failure.code === 'ABORTED'
        ? { kind: 'aborted', failure }
        : { kind: 'error', failure },
  }
}
