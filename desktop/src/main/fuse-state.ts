/**
 * The Electron fuses as the running binary has them (REL-01 诊断包): the
 * wire follows a fixed sentinel in the Electron Framework binary (version
 * byte, length byte, then one byte per fuse: '1' on, '0' off, 'r' removed).
 * Read in chunks, never the whole ~190 MB file at once.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')

/** Fuse names in wire order (@electron/fuses FuseV1Options). */
const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
] as const

export type FuseState = boolean | 'removed'

/** `Emperor Agent.app/Contents/Frameworks/Electron Framework.framework/…`. */
export function electronFrameworkBinary(execPath: string): string {
  return path.resolve(
    execPath,
    '..',
    '..',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  )
}

export async function readFuseStates(
  binary: string,
  options: { chunkBytes?: number } = {},
): Promise<Record<string, FuseState> | null> {
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(binary, 'r')
    const overlap = SENTINEL.length + 2 + 64
    let carry = Buffer.alloc(0)
    let position = 0
    for (;;) {
      const chunk = Buffer.alloc(chunkBytes)
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, position)
      if (bytesRead === 0) return null
      position += bytesRead
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      const at = window.indexOf(SENTINEL)
      if (at >= 0) {
        // Make sure the whole wire is in hand before reading it.
        let wire = window.subarray(at + SENTINEL.length)
        if (wire.length < 2 + FUSES.length) {
          const more = Buffer.alloc(64)
          const extra = await handle.read(more, 0, 64, position)
          wire = Buffer.concat([wire, more.subarray(0, extra.bytesRead)])
        }
        const length = wire[1] ?? 0
        const states: Record<string, FuseState> = {}
        FUSES.forEach((name, index) => {
          if (index >= length) return
          const byte = wire[2 + index]
          if (byte === 0x31) states[name] = true
          else if (byte === 0x30) states[name] = false
          else if (byte === 0x72) states[name] = 'removed'
        })
        return states
      }
      carry = window.subarray(Math.max(0, window.length - overlap))
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
