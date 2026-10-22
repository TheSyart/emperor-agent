import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { mainWindowWebPreferences } from './window-security'

describe('main renderer webPreferences', () => {
  const mainDir = path.join('/tmp', 'emperor', 'out', 'main')

  it('uses one explicit sandboxed configuration for product and smoke windows', () => {
    expect(mainWindowWebPreferences(mainDir, { packaged: false })).toEqual({
      preload: path.join('/tmp', 'emperor', 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      additionalArguments: [],
    })
  })

  it('has no DevTools in a packaged build (MAIN-20)', () => {
    expect(mainWindowWebPreferences(mainDir, { packaged: true })).toMatchObject(
      { devTools: false, sandbox: true, contextIsolation: true },
    )
  })
})
