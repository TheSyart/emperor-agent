import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { resolveAppIconPath } from './icon'

describe('resolveAppIconPath', () => {
  it('resolves the dev icon from the electron main output directory', () => {
    const repoRoot = path.join(path.parse(process.cwd()).root, 'repo')

    expect(
      resolveAppIconPath({
        dirname: path.join(repoRoot, 'desktop', 'out', 'main'),
        isPackaged: false,
        resourcesPath: path.join(repoRoot, 'ignored'),
      }),
    ).toBe(path.join(repoRoot, 'desktop', 'build', 'icon.png'))
  })

  it('resolves the packaged icon from Electron resources', () => {
    const resourcesPath = path.join(
      path.parse(process.cwd()).root,
      'Applications',
      'Emperor Agent.app',
      'Contents',
      'Resources',
    )

    expect(
      resolveAppIconPath({
        dirname: path.join(resourcesPath, 'app.asar', 'out', 'main'),
        isPackaged: true,
        resourcesPath,
      }),
    ).toBe(path.join(resourcesPath, 'icon.png'))
  })
})
