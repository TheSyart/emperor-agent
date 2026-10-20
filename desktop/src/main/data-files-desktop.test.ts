/**
 * REL-03 card test 1, the files main writes: the credential vault, the
 * user's download history and the Agent's download index all carry the
 * version the inventory names.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DATA_FILES,
  declaredVersion,
  inspectDataFiles,
} from '@emperor/core/host-capabilities'
import { LocalSecretStore } from './local-secret-store'
import { CredentialVault } from './computer-use/credential-vault'
import {
  DownloadInbox,
  type DownloadItemLike,
} from './computer-use/download-inbox'
import { UserDownloads } from './user-downloads'

type Listener = (event: unknown, state: any) => void

class FakeItem implements DownloadItemLike {
  savePath = ''
  private done: Listener | null = null
  getFilename = () => 'scan.csv'
  getMimeType = () => 'text/csv'
  getTotalBytes = () => 2
  getReceivedBytes = () => 2
  getURL = () => 'https://files.test/scan.csv'
  setSavePath(path: string): void {
    this.savePath = path
  }
  cancel(): void {}
  on(): this {
    return this
  }
  once(_event: 'done', listener: Listener): this {
    this.done = listener
    return this
  }
  finish(): void {
    this.done?.({}, 'completed')
  }
}

describe('the files main writes', () => {
  it('each carry the version the inventory names (1)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'emperor-desktop-files-'))
    new CredentialVault({
      path: join(home, 'computer-use', 'vault.json'),
      storage: new LocalSecretStore({
        keyPath: join(home, 'computer-use', 'secrets', 'local.key'),
      }),
    }).save({
      label: 'Scan',
      bindings: [{ kind: 'origin', origin: 'https://scan.test' }],
      password: 'scan-password-1234',
    })
    new UserDownloads({
      recordPath: join(home, 'browser', 'user-downloads.json'),
      preferences: () => ({ downloadDirectory: null, askWhereToSave: false }),
      systemDownloads: () => home,
      notify: () => undefined,
      quarantine: async () => undefined,
    }).clear()
    const root = join(home, 'browser', 'downloads')
    const inbox = new DownloadInbox({
      root,
      indexPath: join(root, '.index.json'),
      hashFile: async () => 'd'.repeat(64),
      quarantine: async () => undefined,
    })
    const item = new FakeItem()
    await inbox.receive(
      'tab_1',
      { taskId: 'turn:s1:1', maxBytes: 100, timeoutMs: 5_000, startMs: 200 },
      async () => {
        inbox.offer('tab_1', { preventDefault: vi.fn() }, item)
        writeFileSync(item.savePath, 'a\n')
        item.finish()
      },
      new AbortController().signal,
    )

    const desktopFiles = DATA_FILES.filter((file) => file.owner === 'desktop')
    expect(desktopFiles.map((file) => file.path).sort()).toEqual([
      'browser/downloads/.index.json',
      'browser/user-downloads.json',
      'computer-use/vault.json',
    ])
    for (const file of desktopFiles) {
      const value = JSON.parse(readFileSync(join(home, file.path), 'utf8'))
      expect(declaredVersion(value, file.key), file.path).toBe(file.supported)
    }
    const states = inspectDataFiles(home)
    for (const file of desktopFiles)
      expect(
        states.find((state) => state.path === file.path),
        file.path,
      ).toMatchObject({ state: 'ok', owner: 'desktop' })
  })
})
