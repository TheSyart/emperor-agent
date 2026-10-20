/** Provider-neutral LLM layer: vocabulary, client, routes, and adapters. */

import type { AdapterCallContext, LlmAdapter } from './adapter'
import { DeepSeekAdapter } from './adapters/deepseek/adapter'
import { PiAiAdapter } from './adapters/pi-ai/adapter'
import { LlmClient } from './client'
import type { ImageResolver } from './content'
import type { RouteSpec } from './route'
import type { GenerateOptions, ImageAttachmentRef, StreamChunk } from './types'

export * from './types'
export * from './message'
export * from './error'
export * from './assembler'
export * from './content'
export * from './retry-policy'
export * from './never'
export * from './route'
export * from './client'
export type { LlmAdapter, AdapterCallContext } from './adapter'

/**
 * An adapter whose module loads on its first call, so it stays out of the
 * main bundle's startup chunk (the DeepSeek Messages adapter, KRN-07).
 */
class LazyAdapter implements LlmAdapter {
  private adapter: Promise<LlmAdapter> | null = null

  constructor(private readonly load: () => Promise<LlmAdapter>) {}

  async *stream(
    route: RouteSpec,
    options: GenerateOptions,
    context: AdapterCallContext,
  ): AsyncIterable<StreamChunk> {
    this.adapter ??= this.load()
    yield* (await this.adapter).stream(route, options, context)
  }
}

/** Default adapter selection: one shared instance per transport. */
export function defaultAdapterFor(): (route: RouteSpec) => LlmAdapter {
  const deepseek = new DeepSeekAdapter()
  // One instance per client, so its Files API cache spans the session.
  const messages = new LazyAdapter(async () => {
    const { DeepSeekMessagesAdapter } =
      await import('./adapters/deepseek-messages/adapter')
    return new DeepSeekMessagesAdapter()
  })
  const piAi = new PiAiAdapter()
  return (route) =>
    route.adapter === 'deepseek-messages'
      ? messages
      : route.adapter === 'deepseek'
        ? deepseek
        : piAi
}

/** Create the process-wide client with production adapters. */
export function createLlmClient(
  options: {
    images?: ImageResolver
    imageAvailable?: (ref: ImageAttachmentRef) => boolean
  } = {},
): LlmClient {
  return new LlmClient({
    adapterFor: defaultAdapterFor(),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.imageAvailable === undefined
      ? {}
      : { imageAvailable: options.imageAvailable }),
  })
}
