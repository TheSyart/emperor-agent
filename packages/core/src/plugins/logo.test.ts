import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPluginLogo, pluginLogoUrl, readPluginLogo } from './logo'
import { tempDirectory } from './testing'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24),
])
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16),
])
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
])

function file(name: string, data: Buffer): string {
  const path = join(tempDirectory(), name)
  writeFileSync(path, data)
  return path
}

describe('plugin logos', () => {
  it('accepts PNG, JPEG and WebP by their bytes, not their names', () => {
    expect(checkPluginLogo(file('logo.png', PNG))).toEqual({
      mime: 'image/png',
    })
    expect(checkPluginLogo(file('logo.png', JPEG))).toEqual({
      mime: 'image/jpeg',
    })
    expect(checkPluginLogo(file('logo.bin', WEBP))).toEqual({
      mime: 'image/webp',
    })
    expect(readPluginLogo(file('logo.png', PNG))).toEqual({
      mime: 'image/png',
      bytes: PNG,
    })
  })

  it('refuses what is not a small image file', () => {
    expect(
      checkPluginLogo(file('logo.png', Buffer.from('<svg></svg>'))),
    ).toEqual({
      issue: 'Logo 不是 PNG、JPEG 或 WebP 图片',
    })
    expect(checkPluginLogo(join(tempDirectory(), 'missing.png'))).toEqual({
      issue: '找不到 Logo 文件',
    })
    expect(
      checkPluginLogo(
        file('big.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])),
      ),
    ).toEqual({ issue: 'Logo 超过 1 MiB' })
    const target = file('real.png', PNG)
    const link = join(tempDirectory(), 'link.png')
    symlinkSync(target, link)
    expect(checkPluginLogo(link)).toEqual({ issue: 'Logo 必须是普通文件' })
    expect(readPluginLogo(link)).toBeNull()
  })

  it('addresses a logo through the host, never by path', () => {
    expect(
      pluginLogoUrl({
        pluginId: 'acme/demo',
        scope: 'user',
        digest: 'abcdef0123456789',
      }),
    ).toBe('app://plugin-assets/user/acme%2Fdemo/logo?v=abcdef01')
  })
})
