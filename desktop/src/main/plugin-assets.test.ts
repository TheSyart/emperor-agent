import { describe, expect, it, vi } from 'vitest'
import { appAssetRequestAccess } from './protocol'
import { pluginAssetRequest, pluginAssetResponse } from './plugin-assets'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('app://plugin-assets', () => {
  it('reads the scope and plugin id from the address, nothing else', () => {
    expect(
      pluginAssetRequest(
        new URL('app://plugin-assets/user/acme%2Fdemo/logo?v=abcdef01'),
      ),
    ).toEqual({
      scope: 'user',
      pluginId: 'acme/demo',
    })
    expect(
      pluginAssetRequest(new URL('app://plugin-assets/managed/github/logo')),
    ).toEqual({
      scope: 'managed',
      pluginId: 'github',
    })
    for (const bad of [
      'app://plugin-assets/elsewhere/github/logo',
      'app://plugin-assets/user/github/readme',
      'app://plugin-assets/user/github/logo/extra',
      'app://plugin-assets/user/..%2F..%2Fetc/logo',
      'app://plugin-assets/user/Bad_Name/logo',
    ])
      expect(pluginAssetRequest(new URL(bad)), bad).toBeNull()
  })

  it('answers with the bytes Core vouches for, or 404', async () => {
    const logo = vi.fn((input: { pluginId: string }) =>
      input.pluginId === 'github' ? { mime: 'image/png', bytes: PNG } : null,
    )
    const found = await pluginAssetResponse(
      new URL('app://plugin-assets/managed/github/logo?v=1'),
      logo,
    )
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('image/png')
    expect(found.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await found.arrayBuffer())).toEqual(PNG)
    expect(logo).toHaveBeenCalledWith({ pluginId: 'github', scope: 'managed' })
    expect(
      (
        await pluginAssetResponse(
          new URL('app://plugin-assets/user/nobody/logo'),
          logo,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await pluginAssetResponse(
          new URL('app://plugin-assets/user/x/readme'),
          logo,
        )
      ).status,
    ).toBe(404)
  })

  it('is readable from the renderer origin only', () => {
    expect(appAssetRequestAccess('plugin-assets', 'app://bundle')).toEqual({
      allowed: true,
      allowOrigin: 'app://bundle',
    })
    expect(
      appAssetRequestAccess('plugin-assets', 'https://evil.example').allowed,
    ).toBe(false)
  })
})
