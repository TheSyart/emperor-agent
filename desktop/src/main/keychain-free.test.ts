/**
 * Plan rev 5 §3: nothing Emperor stores goes through the macOS Keychain.
 * From main, Electron's safeStorage was the one way there, so no main source
 * may name it; `scripts/audit-main-keychain.cjs` checks the built bundle the
 * same way after every build (`make check` builds last). The only Keychain
 * read left is the browser import's `security find-generic-password` for
 * Chrome's own key, run when the user presses 导入.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainRoot = resolve(__dirname)
const desktopRoot = resolve(__dirname, '..', '..')
const require = createRequire(import.meta.url)

interface KeychainAudit {
  findSafeStorage(source: string): number[]
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:c|m)?ts$/.test(entry.name) ? [path] : []
  })
}

describe('main process without the Keychain', () => {
  const audit = require(
    join(desktopRoot, 'scripts', 'audit-main-keychain.cjs'),
  ) as KeychainAudit

  it('names Electron safeStorage in no main source', () => {
    const hits = sources(mainRoot)
      .filter((path) => path !== __filename)
      .flatMap((path) =>
        audit
          .findSafeStorage(readFileSync(path, 'utf8'))
          .map((line) => `${relative(desktopRoot, path)}:${line}`),
      )
    expect(hits).toEqual([])
  })

  it('finds safeStorage however a bundle reaches it, and nothing else', () => {
    expect(
      audit.findSafeStorage(
        [
          'const { app, safeStorage } = require("electron")',
          'electron.safeStorage.encryptString(value)',
          'const s = electron["safeStorage"]',
        ].join('\n'),
      ),
    ).toEqual([1, 2, 3])
    // The browser import's own helpers for Chrome's key are not Electron's.
    expect(
      audit.findSafeStorage(
        "readSafeStoragePassword('chrome'); safeStorageService('edge')",
      ),
    ).toEqual([])
  })

  it('audits the built main bundle on every build', () => {
    const pkg = JSON.parse(
      readFileSync(join(desktopRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.build).toContain('node scripts/audit-main-keychain.cjs')
  })

  it('seals with the local key and keeps a mock keychain only as insurance', () => {
    const index = readFileSync(join(mainRoot, 'index.ts'), 'utf8')
    expect(index).toContain("app.commandLine.appendSwitch('use-mock-keychain')")
    expect(index).toContain('new LocalSecretStore(')
    expect(index).toContain('localPairingCipher(localSecrets)')
    expect(index).toContain('verifyPackagedSecrets(config.stateRoot)')
  })
})
