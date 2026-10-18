import { describe, expect, it, vi } from 'vitest'
import { PublicHttpError } from '@emperor/core/host-capabilities'
import { MARKDOWN_REMOTE_IMAGE_CHANNEL } from '../shared/ipc-contract'
import { fetchRemoteImage, registerRemoteImageIpc } from './remote-image-ipc'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function client(response: unknown) {
  return {
    get: vi.fn(async (request: unknown) => {
      void request
      if (response instanceof Error) throw response
      return response as never
    }),
  }
}

describe('remote markdown images through main (UI-38)', () => {
  it('fetches with the public HTTP client and returns a data: URL', async () => {
    const http = client({
      url: 'https://example.com/a.png',
      status: 200,
      headers: { 'content-type': 'image/png; charset=binary' },
      body: PNG,
    })
    const result = await fetchRemoteImage('https://example.com/a.png', http)
    expect(result).toEqual({
      ok: true,
      dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    })
    const request = http.get.mock.calls[0]![0] as Record<string, unknown>
    expect(request).toMatchObject({
      url: 'https://example.com/a.png',
      protocols: ['https:', 'http:'],
    })
    expect(request.maxBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses before any request: not http(s), credentials, junk', async () => {
    const http = client(new Error('must not be called'))
    for (const url of [
      'file:///etc/passwd',
      'app://attachments/x/raw',
      'data:image/png;base64,AAAA',
      'https://user:pw@example.com/a.png',
      'not a url',
      42,
      `https://example.com/${'a'.repeat(5000)}`,
    ])
      expect((await fetchRemoteImage(url, http)).ok).toBe(false)
    expect(http.get).not.toHaveBeenCalled()
  })

  it('says why a local or private address is refused (SSRF guard)', async () => {
    const result = await fetchRemoteImage(
      'http://192.168.1.1/admin.png',
      client(new PublicHttpError('blocked_address')),
    )
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('内网'),
    })
  })

  it('accepts only image responses', async () => {
    for (const response of [
      { status: 200, headers: { 'content-type': 'text/html' }, body: PNG },
      { status: 404, headers: { 'content-type': 'image/png' }, body: PNG },
      { status: 200, headers: {}, body: PNG },
      {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(),
      },
    ])
      expect(
        (
          await fetchRemoteImage(
            'https://example.com/a.png',
            client({ url: 'https://example.com/a.png', ...response }),
          )
        ).ok,
      ).toBe(false)
  })

  it('serves the trusted main window only', async () => {
    const handlers = new Map<
      string,
      (event: unknown, payload: unknown) => unknown
    >()
    const authorize = vi.fn((event: unknown) => {
      if (event !== 'main') throw new Error('IPC caller is not trusted')
    })
    registerRemoteImageIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      authorize,
      client: client({
        url: 'https://example.com/a.png',
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: PNG,
      }),
    })
    const handler = handlers.get(MARKDOWN_REMOTE_IMAGE_CHANNEL)!
    await expect(
      Promise.resolve().then(() =>
        handler('pet', { url: 'https://example.com/a.png' }),
      ),
    ).rejects.toThrow(/not trusted/)
    await expect(
      handler('main', { url: 'https://example.com/a.png' }),
    ).resolves.toMatchObject({ ok: true })
  })
})
