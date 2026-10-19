import { describe, expect, it, vi } from 'vitest'
import {
  verifyPackagedHelpers,
  type PackagedHelpersSmokeDeps,
} from './packaged-helpers-smoke'

const INSTALLED =
  '/tmp/home/.emperor/native-helpers/abc/Emperor Computer Helper.app'

function deps(overrides: Partial<PackagedHelpersSmokeDeps> = {}) {
  const d: PackagedHelpersSmokeDeps = {
    computerHelperStatus: vi.fn(async () => ({ connected: true, protocol: 1 })),
    installedComputerHelper: vi.fn(async () => INSTALLED),
    identity: vi.fn(async () => ({ adHoc: true, runtime: true })),
    release: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    dictationStatus: vi.fn(async () => ({
      available: true,
      engine: 'speech-recognizer',
    })),
    ...overrides,
  }
  return d
}

describe('packaged helper handshakes (SEC-04 test 9)', () => {
  it('reaches both helpers under the hardened runtime and cleans up', async () => {
    const d = deps()
    await expect(verifyPackagedHelpers(d)).resolves.toEqual({
      ok: true,
      mode: 'macos',
      computerUse: { handshake: true, hardenedCopy: true },
      dictation: { available: true },
    })
    expect(d.identity).toHaveBeenCalledWith(INSTALLED)
    expect(d.release).toHaveBeenCalledOnce()
    // The smoke's copy leaves LaunchServices before its folder is deleted.
    expect(d.forget).toHaveBeenCalledWith(INSTALLED)
  })

  it('fails when a helper does not answer or its copy lost the runtime', async () => {
    const cases: Array<[string, Partial<PackagedHelpersSmokeDeps>]> = [
      [
        'computer-use-handshake',
        {
          computerHelperStatus: vi.fn(async () => ({
            connected: false,
            protocol: null,
          })),
        },
      ],
      [
        'computer-use-handshake',
        {
          computerHelperStatus: vi.fn(async () => {
            throw new Error('Computer Use helper did not open its socket')
          }),
        },
      ],
      [
        'computer-use-runtime',
        { identity: vi.fn(async () => ({ adHoc: true, runtime: false })) },
      ],
      [
        'dictation',
        {
          dictationStatus: vi.fn(async () => ({
            available: false,
            engine: null,
          })),
        },
      ],
    ]
    for (const [name, overrides] of cases) {
      const d = deps(overrides)
      await expect(verifyPackagedHelpers(d)).rejects.toThrow(new RegExp(name))
      expect(d.release).toHaveBeenCalledOnce()
    }
  })
})
