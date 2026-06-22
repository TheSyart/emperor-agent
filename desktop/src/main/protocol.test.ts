import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { resolveAssetPath } from './protocol'

const ROOT = '/app/out/renderer'

describe('resolveAssetPath', () => {
  it('maps the root path to index.html', () => {
    expect(resolveAssetPath('/', ROOT)).toBe(path.join(ROOT, 'index.html'))
  })

  it('serves real asset files with an extension', () => {
    expect(resolveAssetPath('/assets/index-abc.js', ROOT)).toBe(path.join(ROOT, 'assets/index-abc.js'))
  })

  it('falls back to index.html for extensionless deep-link routes', () => {
    expect(resolveAssetPath('/chat', ROOT)).toBe(path.join(ROOT, 'index.html'))
    expect(resolveAssetPath('/skills/foo', ROOT)).toBe(path.join(ROOT, 'index.html'))
  })

  it('blocks directory traversal by falling back to index.html', () => {
    expect(resolveAssetPath('/../etc/passwd', ROOT)).toBe(path.join(ROOT, 'index.html'))
    expect(resolveAssetPath('/../../secret.js', ROOT)).toBe(path.join(ROOT, 'index.html'))
  })
})
