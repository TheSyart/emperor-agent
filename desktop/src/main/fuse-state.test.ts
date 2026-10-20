import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronFrameworkBinary, readFuseStates } from './fuse-state'

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
const roots: string[] = []
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'emperor-fuses-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function binary(prefixBytes: number, wire: string): string {
  const file = join(temp(), 'Electron Framework')
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.alloc(prefixBytes, 0x41),
      Buffer.from(SENTINEL),
      Buffer.from([1, wire.length]),
      Buffer.from(wire),
      Buffer.alloc(64, 0x42),
    ]),
  )
  return file
}

describe('fuse state for the diagnostics bundle (REL-01)', () => {
  it('reads the fuse wire by name, also across a read boundary', async () => {
    // The sentinel straddles the 64 KiB chunk the reader uses.
    const file = binary(64 * 1024 - 10, '0011101r1')
    await expect(
      readFuseStates(file, { chunkBytes: 64 * 1024 }),
    ).resolves.toEqual({
      RunAsNode: false,
      EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: true,
      EnableNodeCliInspectArguments: true,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: false,
      LoadBrowserProcessSpecificV8Snapshot: true,
      GrantFileProtocolExtraPrivileges: 'removed',
      WasmTrapHandlers: true,
    })
  })

  it('answers null when there is no binary or no wire', async () => {
    await expect(readFuseStates(join(temp(), 'missing'))).resolves.toBeNull()
    const empty = join(temp(), 'empty')
    writeFileSync(empty, 'no fuses here')
    await expect(readFuseStates(empty)).resolves.toBeNull()
  })

  it('finds the framework next to the app executable', () => {
    expect(
      electronFrameworkBinary(
        '/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent',
      ),
    ).toBe(
      '/Applications/Emperor Agent.app/Contents/Frameworks/Electron Framework.framework/Electron Framework',
    )
  })
})
