import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { resolveMainPreloadPath } from './preload-path'

describe('resolveMainPreloadPath', () => {
  it('matches the electron-vite preload bundle emitted for the desktop app', () => {
    const mainDir = path.join('/tmp', 'emperor-agent', 'desktop', 'out', 'main')

    expect(resolveMainPreloadPath(mainDir)).toBe(
      path.join('/tmp', 'emperor-agent', 'desktop', 'out', 'preload', 'index.mjs'),
    )
  })
})
