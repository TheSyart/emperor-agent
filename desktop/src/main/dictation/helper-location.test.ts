import { describe, expect, it } from 'vitest'
import type { MacosHelperInstallSystem } from '../computer-use/macos-launcher'
import {
  DICTATION_HELPER_IDENTIFIER,
  dictationHelperAppPath,
  dictationHelperExecutable,
  verifyDictationHelper,
} from './helper-location'

function codesign(
  identities: Record<string, string>,
): MacosHelperInstallSystem {
  return {
    execFile: async (_file, args) => {
      const path = args.at(-1)!
      const identity = identities[path]
      if (identity === undefined) throw new Error('code object is not signed')
      if (args[0] === '--verify') return { stdout: '', stderr: '' }
      return { stdout: '', stderr: identity }
    },
  } as MacosHelperInstallSystem
}

function adHoc(identifier: string): string {
  return [
    `Identifier=${identifier}`,
    'CodeDirectory v=20500 size=900 flags=0x2(adhoc) hashes=20+7 location=embedded',
    `CDHash=${'a'.repeat(40)}`,
    'TeamIdentifier=not set',
  ].join('\n')
}

function team(identifier: string, id: string): string {
  return [
    `Identifier=${identifier}`,
    'CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=20+7 location=embedded',
    `CDHash=${'b'.repeat(40)}`,
    `TeamIdentifier=${id}`,
  ].join('\n')
}

describe('dictation helper location', () => {
  it('runs the packaged helper in place, and the development build otherwise', () => {
    expect(
      dictationHelperAppPath({
        packaged: true,
        resourcesPath: '/Applications/Emperor Agent.app/Contents/Resources',
      }),
    ).toBe(
      '/Applications/Emperor Agent.app/Contents/Library/Helpers/Emperor Dictation Helper.app',
    )
    expect(
      dictationHelperAppPath({
        packaged: false,
        desktopRoot: '/src/desktop',
        arch: 'x64',
      }),
    ).toBe(
      '/src/desktop/native/macos/build/x86_64/Emperor Dictation Helper.app',
    )
    expect(dictationHelperExecutable('/H/Emperor Dictation Helper.app')).toBe(
      '/H/Emperor Dictation Helper.app/Contents/MacOS/emperor-dictation-helper',
    )
    expect(() => dictationHelperAppPath({ packaged: true })).toThrow()
  })

  it('accepts a helper signed like Emperor, and nothing else', async () => {
    const helper = '/A/Helpers/Emperor Dictation Helper.app'
    const app = '/A'
    await expect(
      verifyDictationHelper(
        helper,
        app,
        codesign({
          [helper]: adHoc(DICTATION_HELPER_IDENTIFIER),
          [app]: adHoc('com.emperor.agent.desktop'),
        }),
      ),
    ).resolves.toBeUndefined()
    await expect(
      verifyDictationHelper(
        helper,
        app,
        codesign({
          [helper]: team(DICTATION_HELPER_IDENTIFIER, 'ABCDE12345'),
          [app]: team('com.emperor.agent.desktop', 'ABCDE12345'),
        }),
      ),
    ).resolves.toBeUndefined()
    for (const identities of <Record<string, string>[]>[
      {
        [helper]: adHoc('com.example.other'),
        [app]: adHoc('com.emperor.agent.desktop'),
      },
      {
        [helper]: team(DICTATION_HELPER_IDENTIFIER, 'ZZZZZ99999'),
        [app]: team('com.emperor.agent.desktop', 'ABCDE12345'),
      },
      {
        [helper]: adHoc(DICTATION_HELPER_IDENTIFIER),
        [app]: team('com.emperor.agent.desktop', 'ABCDE12345'),
      },
      { [app]: adHoc('com.emperor.agent.desktop') },
    ])
      await expect(
        verifyDictationHelper(helper, app, codesign(identities)),
      ).rejects.toThrow()
  })
})
