/**
 * `PiAiAdapter`: every non-DeepSeek route, served by the pi-ai library's
 * protocol implementations (`openai-completions` / `anthropic-messages`).
 * The route becomes one pi-ai `Model` directly — no pi-ai provider catalog,
 * auth store, or model registry is involved; the key travels per request.
 */

import type {
  Api,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { AdapterCallContext, LlmAdapter } from '../../adapter'
import { assertUsableApiKey, LlmError } from '../../error'
import type { RouteSpec } from '../../route'
import type { GenerateOptions, StreamChunk } from '../../types'
import { idleWatchdog, timeoutOf } from '../../../util/timeout'
import { toPiContext } from './context'
import { toStreamChunks } from './stream'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

let openAi: ProviderStreams | undefined
let anthropic: ProviderStreams | undefined

function streamsFor(route: RouteSpec): ProviderStreams {
  if (route.protocol === 'anthropic')
    return (anthropic ??= anthropicMessagesApi())
  return (openAi ??= openAICompletionsApi())
}

/** Build the pi-ai model descriptor for one route. */
export function piModel(route: RouteSpec): Model<Api> {
  return {
    id: route.modelId,
    name: route.displayName,
    api:
      route.protocol === 'anthropic'
        ? 'anthropic-messages'
        : 'openai-completions',
    provider: route.catalogProvider,
    baseUrl: route.baseURL,
    reasoning: route.reasoning,
    input: route.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow,
    maxTokens: route.maxTokens,
    ...(route.extraHeaders === undefined
      ? {}
      : { headers: { ...route.extraHeaders } }),
  } as Model<Api>
}

export class PiAiAdapter implements LlmAdapter {
  constructor(
    private readonly onReplayDegrade?: (detail: {
      route: string
      reason: string
    }) => void,
  ) {}

  async *stream(
    route: RouteSpec,
    options: GenerateOptions,
    context: AdapterCallContext,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined)
      throw new LlmError(
        'pi-ai routes do not support stop sequences',
        'UNSUPPORTED_OPTION',
      )
    const apiKey =
      route.apiKey === null || route.apiKey === ''
        ? undefined
        : assertUsableApiKey(route.apiKey, route.displayName)
    const model = piModel(route)
    const consumer = new AbortController()
    const upstream =
      options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
    const watchdog = idleWatchdog(
      upstream,
      route.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    )
    try {
      const piContext = await toPiContext(
        { ...options, signal: watchdog.signal },
        context.images,
        (reason) => {
          this.onReplayDegrade?.({ route: route.id, reason })
        },
      )
      const effort = options.reasoningEffort
      const reasoning =
        effort !== undefined && THINKING_LEVELS.has(effort)
          ? (effort as ThinkingLevel)
          : undefined
      const extraBody = route.extraBody
      const streamOptions: SimpleStreamOptions = {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(options.temperature === undefined
          ? {}
          : { temperature: options.temperature }),
        ...(options.maxTokens === undefined
          ? {}
          : { maxTokens: options.maxTokens }),
        ...(options.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
        ...(extraBody === undefined
          ? {}
          : {
              onPayload: (payload: unknown) =>
                typeof payload === 'object' && payload !== null
                  ? { ...payload, ...extraBody }
                  : payload,
            }),
        signal: watchdog.signal,
        // The agent loop owns visible retries; one adapter call is one SDK attempt.
        maxRetries: 0,
      } as SimpleStreamOptions
      const events = streamsFor(route).streamSimple(
        model,
        piContext,
        streamOptions,
      )
      const iterator = toStreamChunks(events, model.contextWindow)[
        Symbol.asyncIterator
      ]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE)
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch {
            // The stable signal already owns SDK termination.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `model stream idle timeout after ${route.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted)
        throw new LlmError('model request aborted by caller', 'ABORTED', {
          cause: error,
        })
      throw error
    } finally {
      watchdog.dispose()
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
