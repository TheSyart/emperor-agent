import { describe, expect, it } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { moduleDirFromUrl } from './esm-path'

describe('moduleDirFromUrl', () => {
  it('derives the module directory from an import.meta.url style file URL', () => {
    const file = path.join(
      os.tmpdir(),
      'emperor-agent',
      'desktop',
      'out',
      'main',
      'index.js',
    )

    expect(moduleDirFromUrl(pathToFileURL(file).toString())).toBe(
      path.dirname(file),
    )
  })
})
