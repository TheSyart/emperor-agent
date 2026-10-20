// The production adapter table: the DeepSeek Messages adapter loads on its
// first call (it stays out of the main bundle's startup chunk) and then
// serves every call of that client.
import { describe, expect, it } from 'vitest'
import { testRoute } from '../harness/testing'
import { defaultAdapterFor } from './index'

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Only the failure matters here.
  }
}

describe('defaultAdapterFor', () => {
  it('hands a deepseek-messages route to the Messages adapter, loaded on first use', async () => {
    const adapterFor = defaultAdapterFor()
    const route = testRoute({
      adapter: 'deepseek-messages',
      displayName: 'DeepSeek',
      apiKey: '',
    })
    const adapter = adapterFor(route)
    // The real adapter's own key check answers: the call reached it.
    await expect(
      drain(adapter.stream(route, { messages: [] } as never, {})),
    ).rejects.toThrow(/DeepSeek: API key is blank/)
    // One shared instance per client, loaded once.
    expect(adapterFor(route)).toBe(adapter)
    await expect(
      drain(adapter.stream(route, { messages: [] } as never, {})),
    ).rejects.toThrow(/API key is blank/)
  })

  it('keeps the chat-completions and pi-ai adapters distinct', () => {
    const adapterFor = defaultAdapterFor()
    const messages = adapterFor(testRoute({ adapter: 'deepseek-messages' }))
    const chat = adapterFor(testRoute({ adapter: 'deepseek' }))
    const piAi = adapterFor(testRoute({ adapter: 'pi-ai' }))
    expect(new Set([messages, chat, piAi]).size).toBe(3)
  })
})
