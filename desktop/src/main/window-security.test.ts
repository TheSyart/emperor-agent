import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { mainWindowWebPreferences } from './window-security'

describe('main renderer webPreferences', () => {
  it('uses one explicit sandboxed configuration for product and smoke windows', () => {
    const mainDir = path.join('/tmp', 'emperor', 'out', 'main')

    expect(mainWindowWebPreferences(mainDir)).toEqual({
      preload: path.join('/tmp', 'emperor', 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [],
    })
  })
})
