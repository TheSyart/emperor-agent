/** Provider-neutral LLM layer: vocabulary, client, routes, and adapters. */

import type { LlmAdapter } from './adapter'
import { DeepSeekAdapter } from './adapters/deepseek/adapter'
import { PiAiAdapter } from './adapters/pi-ai/adapter'
import { LlmClient } from './client'
import type { ImageResolver } from './content'
import type { RouteSpec } from './route'
import type { ImageAttachmentRef } from './types'

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

/** Default adapter selection: one shared instance per transport. */
export function defaultAdapterFor(): (route: RouteSpec) => LlmAdapter {
  const deepseek = new DeepSeekAdapter()
  const piAi = new PiAiAdapter()
  return (route) => (route.adapter === 'deepseek' ? deepseek : piAi)
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
