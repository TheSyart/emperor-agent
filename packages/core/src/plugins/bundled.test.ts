import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePluginPackage } from './manifest-resolver'

const BUNDLED = join(__dirname, '..', '..', 'bundled-plugins')

describe('packages shipped with Emperor', () => {
  it('are two valid portable packages named as the contract says', () => {
    expect(readdirSync(BUNDLED).sort()).toEqual(['computer-use', 'github'])
    const resolved = ['computer-use', 'github'].map((name) =>
      resolvePluginPackage(join(BUNDLED, name), { strict: true }),
    )
    expect(
      resolved.map(
        ({ pluginId, format, displayName, developerName, description }) => ({
          pluginId,
          format,
          displayName,
          developerName,
          description,
        }),
      ),
    ).toEqual([
      {
        pluginId: 'computer-use',
        format: 'portable',
        displayName: 'Computer Use',
        developerName: 'Emperor Agent',
        description: '让 Emperor 操作浏览器和 Mac 上的应用',
      },
      {
        pluginId: 'github',
        format: 'portable',
        displayName: 'GitHub',
        developerName: 'Emperor Agent',
        description: '与 GitHub 集成',
      },
    ])
  })
})
