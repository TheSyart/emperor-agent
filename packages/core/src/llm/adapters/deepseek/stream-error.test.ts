// KRN-13 (finding CORE-43): an error object sent inside the SSE stream ends
// the request with that error instead of being skipped as a chunk without
// choices (the stream would otherwise look like an empty reply).
import { describe, expect, it } from 'vitest'
import { LlmError } from '../../index'
import type { StreamChunk } from '../../index'
import { DONE } from './sse'
import { translate } from './translate'

async function* feed(...payloads: (string | object)[]): AsyncGenerator<string> {
  for (const payload of payloads)
    yield typeof payload === 'string' ? payload : JSON.stringify(payload)
}

async function collect(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('translate: an error inside the stream (KRN-13)', () => {
  it('8 · ends the request with the provider’s error', async () => {
    const run = collect(
      translate(
        feed(
          { choices: [{ delta: { content: 'partial' } }] },
          {
            error: {
              message: 'Rate limit reached for requests',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded',
            },
          },
          DONE,
        ),
      ),
    )
    await expect(run).rejects.toBeInstanceOf(LlmError)
    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining('Rate limit reached'),
      code: 'RATE_LIMIT',
    })
  })

  it('a server error without a known type is a server failure', async () => {
    await expect(
      collect(translate(feed({ error: { message: 'internal error' } }, DONE))),
    ).rejects.toMatchObject({
      message: expect.stringContaining('internal error'),
      code: 'SERVER',
    })
  })

  it('a chunk with an empty error field is not an error', async () => {
    const chunks = await collect(
      translate(
        feed(
          { choices: [{ delta: { content: 'ok' } }], error: null },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          DONE,
        ),
      ),
    )
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })
})
