import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_RENDERER_URL,
  developmentRendererUrl,
  mainRendererUrl,
} from './renderer-url'

describe('main window URL (SEC-04, MAIN-10)', () => {
  const dev = { ELECTRON_RENDERER_URL: 'http://localhost:5173/' }

  it('6. ignores ELECTRON_RENDERER_URL in a packaged app', () => {
    // launchctl setenv could point a packaged Emperor at a remote page that
    // would then hold every IPC channel of the main window.
    for (const url of ['https://example.com', 'http://localhost:5173/'])
      expect(
        mainRendererUrl({
          isPackaged: true,
          env: { ELECTRON_RENDERER_URL: url },
        }),
      ).toBe('app://bundle/index.html')
    expect(developmentRendererUrl({ isPackaged: true, env: dev })).toBeNull()
  })

  it('uses the Vite dev server only in development', () => {
    expect(developmentRendererUrl({ isPackaged: false, env: dev })).toBe(
      'http://localhost:5173/',
    )
    expect(mainRendererUrl({ isPackaged: false, env: dev })).toBe(
      'http://localhost:5173/',
    )
    expect(mainRendererUrl({ isPackaged: false, env: {} })).toBe(
      PRODUCTION_RENDERER_URL,
    )
    expect(
      mainRendererUrl({
        isPackaged: false,
        env: { ELECTRON_RENDERER_URL: '' },
      }),
    ).toBe(PRODUCTION_RENDERER_URL)
  })
})
