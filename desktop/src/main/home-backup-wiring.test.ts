/**
 * REL-03 in main/index.ts, held by its source (the e2e drives the real
 * thing): a scheduled restore is applied before the Emperor Home is
 * bootstrapped and Core starts; pending data migrations run after the
 * bootstrap; 备份与恢复 is registered behind the trusted-window check and
 * loads its code only when asked.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

function indexOf(snippet: string, from = 0): number {
  const at = source.indexOf(snippet, from)
  if (at < 0) throw new Error(`index.ts lacks ${snippet}`)
  return at
}

describe('备份与恢复 and data versions in main (REL-03)', () => {
  it('restores, bootstraps, migrates, then starts Core — in that order', () => {
    const lock = indexOf('stateDirectoryLock = acquireStateDirectoryLock(')
    const restore = indexOf('await applyPendingHomeRestore(', lock)
    const prepare = indexOf('prepareMainRuntime()', restore)
    const migrate = indexOf('await runPendingDataMigrations(', prepare)
    const core = indexOf('coreApi = await createCoreHost(', migrate)
    expect(lock).toBeLessThan(restore)
    expect(restore).toBeLessThan(prepare)
    expect(prepare).toBeLessThan(migrate)
    expect(migrate).toBeLessThan(core)
  })

  it('registers the IPC behind the trusted window and loads it lazily', () => {
    expect(source).toMatch(
      /registerHomeBackupIpc\(\{[\s\S]*?authorize: \(event\) => trustedRendererPolicy\.authorizeIpc\(event\)/,
    )
    expect(source).toContain("await import('./home-backup')")
    expect(source).not.toMatch(/^import .* from '\.\/home-backup'$/m)
  })
})
