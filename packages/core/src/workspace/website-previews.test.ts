import { describe, expect, it, vi } from 'vitest'
import { WebsitePreviewError, WebsitePreviewRegistry } from './website-previews'

describe('WebsitePreviewRegistry', () => {
  it('exposes stable safe errors without internal details', () => {
    const error = new WebsitePreviewError(
      'website_preview_owner_invalid',
      'Website preview does not belong to this session.',
    )

    expect(error.toSafe()).toEqual({
      code: 'website_preview_owner_invalid',
      message: 'Website preview does not belong to this session.',
    })
    expect(JSON.stringify(error.toSafe())).not.toMatch(/stack|cause/)
  })

  it('registers a ready loopback endpoint only after a successful probe', async () => {
    const probe = vi.fn(async () => true)
    const registry = new WebsitePreviewRegistry({ probe })
    const preview = await registry.register({
      sessionId: 'session-1',
      processId: 'process-1',
      revision: 1,
      title: 'Demo website',
      url: 'http://127.0.0.1:43121/',
      primary: true,
    })

    expect(preview).toMatchObject({
      sessionId: 'session-1',
      processId: 'process-1',
      status: 'ready',
      primary: true,
    })
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:43121/')
    expect(registry.authorize(preview.id, 'session-1')).toEqual(preview)
  })

  it('rejects remote, credential-bearing, and unsupported preview URLs', async () => {
    const registry = new WebsitePreviewRegistry({ probe: async () => true })
    for (const url of [
      'https://example.com',
      'http://user:secret@127.0.0.1:43121/',
      'file:///tmp/index.html',
    ]) {
      await expect(
        registry.register({
          sessionId: 'session-1',
          processId: 'process-1',
          revision: 1,
          title: 'Unsafe',
          url,
          primary: false,
        }),
      ).rejects.toBeInstanceOf(WebsitePreviewError)
    }
  })

  it('binds preview capability to session and process revision', async () => {
    const registry = new WebsitePreviewRegistry({ probe: async () => true })
    const preview = await registry.register({
      sessionId: 'session-1',
      processId: 'process-1',
      revision: 2,
      title: 'Demo',
      url: 'http://localhost:43121/',
      primary: false,
    })

    expect(() => registry.authorize(preview.id, 'session-2')).toThrow(
      WebsitePreviewError,
    )
    expect(() => registry.authorize(preview.id, 'session-1', 1)).toThrow(
      WebsitePreviewError,
    )
  })

  it('deduplicates one preview per process revision and stops it with the owner', async () => {
    const registry = new WebsitePreviewRegistry({ probe: async () => true })
    const input = {
      sessionId: 'session-1',
      processId: 'process-1',
      revision: 3,
      title: 'Demo',
      url: 'http://[::1]:43121/',
      primary: true,
    } as const
    const first = await registry.register(input)
    const second = await registry.register(input)
    expect(second.id).toBe(first.id)

    const stopped = registry.stopProcess('session-1', 'process-1', 3)
    expect(stopped).toMatchObject({ id: first.id, status: 'stopped' })
    expect(registry.list('session-1')).toHaveLength(1)
  })

  it('records an unreachable loopback endpoint without granting navigation', async () => {
    const registry = new WebsitePreviewRegistry({ probe: async () => false })
    const preview = await registry.register({
      sessionId: 'session-1',
      processId: 'process-1',
      revision: 1,
      title: 'Demo',
      url: 'http://127.0.0.1:43121/',
      primary: false,
    })
    expect(preview.status).toBe('unreachable')
    expect(() => registry.authorize(preview.id, 'session-1')).toThrow(
      /not ready/i,
    )
  })
})
