/**
 * `DeepSeekMessagesAdapter`: DeepSeek's official host over the Anthropic
 * Messages API (`https://api.deepseek.com/anthropic/v1/messages`, KRN-07).
 * Thinking signatures replay verbatim, effort travels as
 * `output_config.effort`, and images go through the Files API with an
 * inline fallback. Custom gateways and entries that keep chat-completions
 * use `DeepSeekAdapter` instead (route.ts decides).
 *
 * One stable signal reaches the fetch and every body read. Caller aborts
 * map to `ABORTED`, the per-read idle watchdog to `TIMEOUT`. Before any
 * chunk is streamed, one rejected request may be repaired and sent again:
 * file ids the endpoint no longer knows go inline, and unsigned thinking is
 * left out when the endpoint asks for a signature.
 */

import type { AdapterCallContext, LlmAdapter } from '../../adapter'
import {
  assertUsableApiKey,
  httpErrorCode,
  LlmError,
  retryAfterMs,
} from '../../error'
import type { RouteSpec } from '../../route'
import type { GenerateOptions, StreamChunk } from '../../types'
import { idleWatchdog, timeoutOf } from '../../../util/timeout'
import { ANTHROPIC_VERSION, FILES_API_BETA, MESSAGES_PATH } from './constants'
import { DeepSeekImageFiles } from './files'
import {
  messagesRequestDefaults,
  serializeMessagesRequest,
  type SerializedRequest,
} from './serialize'
import { parseEvents } from './sse'
import { sipsTranscoder, type ImageTranscoder } from './transcode'
import { translateEvents } from './translate'
import type { WireErrorResponse } from './types'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

export interface DeepSeekMessagesAdapterOptions {
  /** Transport (tests replay fixtures through it); default: global fetch. */
  fetch?: typeof fetch
  /** JPEG encoder for uploads; null: upload images as they are. Default: sips on macOS. */
  transcoder?: ImageTranscoder | null
  now?: () => number
}

interface Repair {
  inline: boolean
  dropUnsignedThinking: boolean
}

interface HttpFailure {
  status: number
  message: string
  detail: string
  raw: string
  retryAfterMs?: number
  requestId?: string
}

function requestId(headers: Headers): string | undefined {
  const value = headers.get('request-id') ?? headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : value
}

async function readFailure(response: Response): Promise<HttpFailure> {
  const raw = await response.text()
  let message = `DeepSeek API error (HTTP ${response.status})`
  let detail = ''
  try {
    const error = (JSON.parse(raw) as WireErrorResponse).error
    if (error?.message) message = error.message
    detail = [error?.code, error?.type, error?.message]
      .filter((field): field is string => typeof field === 'string')
      .join(' ')
  } catch {
    // The HTTP status stays authoritative when a gateway returns non-JSON.
  }
  const delay = retryAfterMs(response.headers.get('retry-after'))
  const id = requestId(response.headers)
  return {
    status: response.status,
    message,
    detail,
    raw,
    ...(delay === undefined ? {} : { retryAfterMs: delay }),
    ...(id === undefined ? {} : { requestId: id }),
  }
}

function failureError(failure: HttpFailure): LlmError {
  return new LlmError(
    failure.message,
    httpErrorCode(failure.status, failure.detail),
    {
      cause: new Error(
        failure.raw.length > 0
          ? failure.raw
          : `DeepSeek HTTP ${failure.status}`,
      ),
      status: failure.status,
      ...(failure.retryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: failure.retryAfterMs }),
      ...(failure.requestId === undefined
        ? {}
        : { requestId: failure.requestId }),
    },
  )
}

/** The one repair a rejected request may get, if it fits the rejection. */
function repairFor(
  failure: HttpFailure,
  sent: SerializedRequest,
): Repair | undefined {
  if (failure.status !== 400 && failure.status !== 404) return undefined
  const text = `${failure.detail} ${failure.message}`
  const files = sent.fileIds.length > 0 && /\bfile/i.test(text)
  const thinking =
    failure.status === 400 &&
    sent.hasUnsignedThinking &&
    /signature|thinking/i.test(text)
  if (!files && !thinking) return undefined
  return { inline: files, dropUnsignedThinking: thinking }
}

export class DeepSeekMessagesAdapter implements LlmAdapter {
  private readonly files: DeepSeekImageFiles
  private readonly fetchImpl: typeof fetch

  constructor(options: DeepSeekMessagesAdapterOptions = {}) {
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.files = new DeepSeekImageFiles({
      fetch: this.fetchImpl,
      transcoder:
        options.transcoder === undefined
          ? (sipsTranscoder ?? null)
          : options.transcoder,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  async *stream(
    route: RouteSpec,
    options: GenerateOptions,
    context: AdapterCallContext,
  ): AsyncIterable<StreamChunk> {
    const apiKey = assertUsableApiKey(route.apiKey ?? '', route.displayName)
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
    const iterator = this.request(
      route,
      options,
      watchdog.signal,
      apiKey,
      context,
      () => {
        watchdog.pulse()
      },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${route.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted)
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', {
          cause: error,
        })
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `DeepSeek Messages stream from ${route.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    } finally {
      watchdog.dispose()
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async post(
    route: RouteSpec,
    sent: SerializedRequest,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...route.extraHeaders,
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(sent.fileIds.length > 0 ? { 'anthropic-beta': FILES_API_BETA } : {}),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
    try {
      return await this.fetchImpl(`${route.baseURL}${MESSAGES_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(sent.body),
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `DeepSeek API request to ${route.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }
  }

  private async *request(
    route: RouteSpec,
    options: GenerateOptions,
    signal: AbortSignal,
    apiKey: string,
    context: AdapterCallContext,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const origin = new URL(route.baseURL).origin
    const defaults = messagesRequestDefaults(route)
    const images = context.images
    const serialize = (repair: Repair): Promise<SerializedRequest> =>
      serializeMessagesRequest({ ...options, signal }, defaults, {
        ...(images === undefined ? {} : { images }),
        ...(route.vision && images !== undefined && !repair.inline
          ? {
              imageSource: (ref, imageSignal) =>
                this.files.source({
                  origin,
                  apiKey,
                  ref,
                  images,
                  ...(imageSignal === undefined ? {} : { signal: imageSignal }),
                }),
            }
          : {}),
        dropUnsignedThinking: repair.dropUnsignedThinking,
      })
    let sent = await serialize({ inline: false, dropUnsignedThinking: false })
    let response = await this.post(route, sent, apiKey, signal)
    if (!response.ok) {
      const failure = await readFailure(response)
      const repair = repairFor(failure, sent)
      if (repair === undefined) throw failureError(failure)
      if (repair.inline) this.files.invalidate(origin, apiKey, sent.fileIds)
      sent = await serialize(repair)
      response = await this.post(route, sent, apiKey, signal)
      if (!response.ok) throw failureError(await readFailure(response))
    }
    if (!response.body)
      throw new LlmError(
        'DeepSeek API returned no response body',
        'EMPTY_RESPONSE',
      )
    yield* translateEvents(parseEvents(response.body, onActivity), {
      model: options.model,
    })
  }
}
