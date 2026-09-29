/**
 * Plugin logos (plugin contract §6.3). A logo is a package file under
 * `assets/` (the resolver checks the path); here its bytes are checked: a
 * regular file of at most 1 MiB that starts like a PNG, JPEG or WebP image.
 * The renderer only ever gets a host address, never the path.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import type { PluginScope } from './models'

const MAX_LOGO_BYTES = 1024 * 1024

export type PluginLogoCheck = { mime: string } | { issue: string }

/** Whether `path` holds an image Emperor will show, and its type. */
export function checkPluginLogo(path: string): PluginLogoCheck {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { issue: '找不到 Logo 文件' }
  }
  if (!stat.isFile()) return { issue: 'Logo 必须是普通文件' }
  if (stat.size > MAX_LOGO_BYTES) return { issue: 'Logo 超过 1 MiB' }
  const head = Buffer.alloc(12)
  let read = 0
  try {
    const fd = openSync(path, 'r')
    try {
      read = readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
  } catch {
    return { issue: '无法读取 Logo 文件' }
  }
  const mime = imageType(head.subarray(0, read))
  return mime ? { mime } : { issue: 'Logo 不是 PNG、JPEG 或 WebP 图片' }
}

/** The logo's bytes and type, or `null` when it fails the check. */
export function readPluginLogo(
  path: string,
): { mime: string; bytes: Buffer } | null {
  const check = checkPluginLogo(path)
  if (!('mime' in check)) return null
  try {
    return { mime: check.mime, bytes: readFileSync(path) }
  } catch {
    return null
  }
}

/** The host address of a plugin's logo; `v` changes with the package content. */
export function pluginLogoUrl(input: {
  pluginId: string
  scope: PluginScope
  digest: string
}): string {
  return `app://plugin-assets/${input.scope}/${encodeURIComponent(input.pluginId)}/logo?v=${input.digest.slice(0, 8)}`
}

function imageType(head: Buffer): string | null {
  if (
    head.length >= 8 &&
    head
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  )
    return 'image/jpeg'
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}
