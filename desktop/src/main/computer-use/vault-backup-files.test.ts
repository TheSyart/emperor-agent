import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupFilePath,
  defaultBackupName,
  readBackupFile,
  writeBackupFile,
} from './vault-backup-files'

describe('vault backup files', () => {
  it('names the file and adds the extension the save dialog left off', () => {
    expect(defaultBackupName(new Date(2026, 9, 9))).toBe(
      'Emperor 凭据备份 2026-10-09.emperor-vault',
    )
    expect(backupFilePath('/Users/a/备份')).toBe('/Users/a/备份.emperor-vault')
    expect(backupFilePath('/Users/a/x.emperor-vault')).toBe(
      '/Users/a/x.emperor-vault',
    )
  })

  it('writes a private file whole and reads back only regular, small files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'emperor-vault-backup-'))
    const path = join(dir, 'b.emperor-vault')
    await writeBackupFile(path, Buffer.from('first'))
    await writeBackupFile(path, Buffer.from('second'))
    expect(readFileSync(path, 'utf8')).toBe('second')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['b.emperor-vault'])
    expect((await readBackupFile(path)).toString()).toBe('second')
    const big = join(dir, 'big.emperor-vault')
    writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(readBackupFile(big)).rejects.toThrow('not an Emperor')
    const link = join(dir, 'link.emperor-vault')
    symlinkSync(path, link)
    await expect(readBackupFile(link)).rejects.toThrow()
    mkdirSync(join(dir, 'folder.emperor-vault'))
    await expect(
      writeBackupFile(join(dir, 'folder.emperor-vault'), Buffer.from('x')),
    ).rejects.toThrow('replace a file')
  })
})
