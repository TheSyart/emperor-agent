/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks (ported from
 * dsh-llm-deepseek adapter.ts, without the Files API upload path).
 *
 * One stable signal reaches both the initial fetch and body reads. Caller
 * aborts map to `ABORTED`; the per-read idle watchdog maps to `TIMEOUT`.
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
import { serializeRequest, type RequestDefaults } from './serialize'
import { parseSse } from './sse'
import { translate } from './translate'
import type { WireError } from './types'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function requestDefaults(route: RouteSpec): RequestDefaults {
  const effort = route.defaultReasoningEffort
  return {
    ...(effort === 'off' ||
    effort === 'low' ||
    effort === 'high' ||
    effort === 'max'
      ? { reasoningEffort: effort }
      : {}),
    ...(route.extraBody === undefined ? {} : { extraBody: route.extraBody }),
  }
}

function requestId(headers: Headers): string | undefined {
  const value =
    headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : value
}

export class DeepSeekAdapter implements LlmAdapter {
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
        `DeepSeek API stream from ${route.baseURL} failed`,
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

  private async *request(
    route: RouteSpec,
    options: GenerateOptions,
    signal: AbortSignal,
    apiKey: string,
    context: AdapterCallContext,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = await serializeRequest(
      options,
      requestDefaults(route),
      context.images,
    )
    const headers: Record<string, string> = {
      ...route.extraHeaders,
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
    let response: Response
    try {
      response = await fetch(`${route.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      let providerError: WireError['error']
      const raw = await response.text()
      try {
        providerError = (JSON.parse(raw) as WireError).error
        if (providerError?.message) message = providerError.message
      } catch {
        // The HTTP status remains authoritative when a gateway returns malformed JSON.
      }
      const detail = [
        providerError?.code,
        providerError?.type,
        providerError?.message,
      ]
        .filter((field): field is string => typeof field === 'string')
        .join(' ')
      const delay = retryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, detail), {
        cause: new Error(
          raw.length > 0 ? raw : `DeepSeek HTTP ${response.status}`,
        ),
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        ...(id === undefined ? {} : { requestId: id }),
      })
    }
    if (!response.body)
      throw new LlmError(
        'DeepSeek API returned no response body',
        'EMPTY_RESPONSE',
      )
    yield* translate(parseSse(response.body, onActivity))
  }
}
