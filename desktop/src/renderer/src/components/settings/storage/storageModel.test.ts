import { describe, expect, it } from 'vitest'
import {
  STORAGE_CATEGORY_TEXT,
  cleanSummary,
  formatStorageBytes,
} from './storageModel'

// 设置 › 高级 › 存储 (KRN-12): sizes as the page shows them, and the line
// that says what 「清理」 freed.
describe('storageModel', () => {
  it('formats allocated bytes from B to GB', () => {
    expect(formatStorageBytes(0)).toBe('0 B')
    expect(formatStorageBytes(512)).toBe('512 B')
    expect(formatStorageBytes(1536)).toBe('1.5 KB')
    expect(formatStorageBytes(4096)).toBe('4 KB')
    expect(formatStorageBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatStorageBytes(12.34 * 1024 * 1024)).toBe('12.3 MB')
    expect(formatStorageBytes(1.25 * 1024 ** 3)).toBe('1.25 GB')
    expect(formatStorageBytes(-1)).toBe('0 B')
  })

  it('names every category Core reports', () => {
    expect(Object.keys(STORAGE_CATEGORY_TEXT)).toEqual([
      'sessions',
      'attachments',
      'spill',
      'memoryVersions',
      'ledger',
      'delegations',
      'other',
    ])
    for (const text of Object.values(STORAGE_CATEGORY_TEXT)) {
      expect(text.title).not.toBe('')
      expect(text.description).not.toBe('')
    }
  })

  const none = { removed: 0, bytes: 0 }

  it('says what was freed, only the parts that freed something', () => {
    expect(
      cleanSummary({
        sessions: { removed: 1, bytes: 2 * 1024 * 1024 },
        spill: { removed: 3, bytes: 10 * 1024 * 1024 },
        memoryVersions: none,
        delegations: { removed: 2, bytes: 512 * 1024 },
        freedBytes: 12.5 * 1024 * 1024,
        errors: [],
      }),
    ).toBe(
      '已释放 12.5 MB：最近删除的会话 1 个、溢出文件 3 项、委派目录 2 项。',
    )
  })

  it('says when there was nothing to clean, and what could not be cleaned', () => {
    const clean = {
      sessions: none,
      spill: none,
      memoryVersions: none,
      delegations: none,
      freedBytes: 0,
      errors: [],
    }
    expect(cleanSummary(clean)).toBe('没有需要清理的文件。')
    expect(
      cleanSummary({ ...clean, errors: ['spill: EACCES', 'delegations: x'] }),
    ).toBe('没有需要清理的文件。另有 2 类文件没能清理，稍后会再试。')
  })
})
