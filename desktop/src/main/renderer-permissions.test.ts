import { describe, expect, it } from 'vitest'
import { defaultSessionPermission } from './renderer-permissions'

describe('default session permissions (MAIN-3)', () => {
  const main = { id: 1, url: 'app://bundle/chat/s1' }
  const hijacked = { id: 1, url: 'https://evil.example/' }
  const pet = { id: 2, url: 'app://pet/renderer.html' }
  const allow = defaultSessionPermission({
    // The main window's webContents while it shows Emperor's own page.
    isTrustedMainRenderer: (contents) =>
      (contents as { id?: number } | null)?.id === 1 &&
      (contents as { url: string }).url.startsWith('app://bundle/'),
  })

  it('denies the microphone, camera, screen, notifications and the rest', () => {
    for (const permission of [
      'media',
      'display-capture',
      'notifications',
      'geolocation',
      'midi',
      'midiSysex',
      'pointerLock',
      'fullscreen',
      'openExternal',
      'clipboard-read',
      'idle-detection',
      'storage-access',
      'window-management',
      'unknown',
    ])
      expect(allow(main, permission, 'app://bundle', ['audio'])).toBe(false)
  })

  it('lets only the main window write text to the clipboard (copy buttons)', () => {
    // Node's URL gives app: origins as "null"; the page itself is checked.
    expect(allow(main, 'clipboard-sanitized-write', 'null', [])).toBe(true)
    expect(allow(pet, 'clipboard-sanitized-write', 'null', [])).toBe(false)
    expect(allow(null, 'clipboard-sanitized-write', 'null', [])).toBe(false)
    expect(allow(hijacked, 'clipboard-sanitized-write', 'null', [])).toBe(false)
  })
})
