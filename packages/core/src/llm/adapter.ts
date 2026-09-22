/** Provider-wire adapter contract. */

import type { ImageResolver } from './content'
import type { RouteSpec } from './route'
import type { GenerateOptions, StreamChunk } from './types'

/** Dependencies an adapter call may need beyond its route. */
export interface AdapterCallContext {
  /** Resolves stored image bytes; absent means images cannot be sent. */
  images?: ImageResolver
}

/**
 * Stream one model call as raw chunks. Implementations must honor
 * `options.signal`, emit `usage` before the terminal `finish`, and may either
 * throw or deliver failures as an error/aborted finish; {@link LlmClient}
 * normalizes throws into terminal finish chunks.
 */
export interface LlmAdapter {
  stream(
    route: RouteSpec,
    options: GenerateOptions,
    context: AdapterCallContext,
  ): AsyncIterable<StreamChunk>
}
