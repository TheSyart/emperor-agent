/**
 * BRD-05 card test 8: `app://skin/<id>/<file>` names a skin and one of its
 * slot pictures, nothing else. No address reaches a file outside the
 * skins folders, and nothing but GET is answered.
 */
import { describe, expect, it, vi } from 'vitest'
import { skinAssetRequest, skinAssetResponse } from './skin-protocol'

const asset = vi.fn((id: string, file: string) =>
  id === 'paper' && file === 'hero.webp'
    ? { mime: 'image/webp' as const, bytes: Buffer.from('RIFF') }
    : null,
)

function get(url: string, method = 'GET'): Promise<Response> {
  return skinAssetResponse(new Request(url, { method }), asset)
}

describe('app://skin', () => {
  it('serves a slot picture read-only, typed and not sniffed', async () => {
    const response = await get('app://skin/paper/hero.webp?v=abc')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(asset).toHaveBeenLastCalledWith('paper', 'hero.webp')
  })

  it('reads only <id>/<file> with a plain picture name', () => {
    expect(skinAssetRequest(new URL('app://skin/paper/hero.webp'))).toEqual({
      id: 'paper',
      file: 'hero.webp',
    })
    for (const url of [
      'app://skin/paper/../../settings.json',
      'app://skin/paper/..%2F..%2Fsettings.json',
      'app://skin/paper/%2e%2e/%2e%2e/settings.json',
      'app://skin/..%2Fsettings/hero.webp',
      'app://skin/paper/sub/hero.webp',
      'app://skin/paper/skin.json',
      'app://skin/paper/hero.svg',
      'app://skin/paper/.hero.webp',
      'app://skin/paper/hero.webp%00.png',
      'app://skin/Paper/hero.webp',
      'app://skin/paper',
      'app://skin/%2Fetc%2Fhosts/x.png',
    ])
      expect(skinAssetRequest(new URL(url)), url).toBeNull()
  })

  it('answers 404 for anything the store does not hand out', async () => {
    for (const url of [
      'app://skin/paper/../../settings.json',
      'app://skin/paper/pet.png',
      'app://skin/zhupi/hero.webp',
    ])
      expect((await get(url)).status, url).toBe(404)
  })

  it('answers nothing but GET', async () => {
    expect((await get('app://skin/paper/hero.webp', 'POST')).status).toBe(405)
    expect((await get('app://skin/paper/hero.webp', 'PUT')).status).toBe(405)
  })
})
