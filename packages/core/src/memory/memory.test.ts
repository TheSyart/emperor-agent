/**
 * 记忆子系统契约 (MIG-MEM-001/002)。
 *  - MemoryStore: long-term memory / daily episodes / user profile (no history.jsonl)
 *  - tests/unit/test_memory_versions.py (MemoryVersionStore snapshot/restore/dedupe + MemoryStore writes 建版本)
 */
import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from './store'
import { MemoryVersionStore, memoryVersionFromDict } from './versions'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('MemoryStore (lean durable memory)', () => {
  it('creates only the long-term memory file, never history or checkpoint files', () => {
    const root = tmp('emperor-memstore-')
    const memoryDir = join(root, 'memory')
    const memory = new MemoryStore(memoryDir, join(root, 'USER.local.md'))
    expect(memory.memoryFile).toBe(join(memoryDir, 'MEMORY.local.md'))
    expect(readdirSync(memoryDir).sort()).toEqual(['MEMORY.local.md'])
    expect(existsSync(join(memoryDir, 'history.jsonl'))).toBe(false)
    expect(existsSync(join(memoryDir, '_checkpoint.json'))).toBe(false)
    expect(memory.readMemory()).toContain('# 长期记忆')
  })

  it('seeds from template and migrates legacy MEMORY.md', () => {
    const root = tmp('emperor-memstore-tpl-')
    const template = join(root, 'template.md')
    writeFileSync(template, '# tpl\n', 'utf8')
    const a = new MemoryStore(join(root, 'a'), join(root, 'USER.local.md'), {
      memoryTemplate: template,
    })
    expect(a.readMemory()).toBe('# tpl\n')

    const legacyDir = join(root, 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'MEMORY.md'), 'legacy memory\n', 'utf8')
    const b = new MemoryStore(legacyDir, join(root, 'USER.local.md'))
    expect(b.readMemory()).toBe('legacy memory\n')
    expect(existsSync(join(legacyDir, 'MEMORY.md'))).toBe(false)
  })

  it('tolerates legacy history files on disk without reading them', () => {
    const root = tmp('emperor-memstore-legacy-')
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'history.jsonl'), '{bad json\n', 'utf8')
    writeFileSync(join(memoryDir, '_checkpoint.json'), '{bad', 'utf8')
    const memory = new MemoryStore(memoryDir, join(root, 'USER.local.md'))
    memory.writeMemory('kept')
    expect(memory.readMemory()).toBe('kept\n')
    expect(readFileSync(join(memoryDir, 'history.jsonl'), 'utf8')).toBe(
      '{bad json\n',
    )
  })

  it('appends daily episodes and snapshots before rewriting', () => {
    const root = tmp('emperor-memstore-episode-')
    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'USER.local.md'),
    )
    expect(memory.readTodayEpisode()).toBe('')
    memory.appendEpisode('first event')
    memory.appendEpisode('  second event  ')
    const text = memory.readTodayEpisode()
    expect(text).toMatch(
      /^# \d{4}-\d{2}-\d{2} 情景记忆\n\nfirst event\n\nsecond event\n$/,
    )
    expect(memory.todayEpisodePath().endsWith('.md')).toBe(true)
    expect(memory.versions.list({ target: 'episode' }).length).toBe(1)
  })

  it('reads and writes the user profile with versions', () => {
    const root = tmp('emperor-memstore-user-')
    const userFile = join(root, 'USER.local.md')
    const memory = new MemoryStore(join(root, 'memory'), userFile)
    expect(memory.readUser()).toBe('')
    memory.writeUser('  profile v1 ')
    expect(readFileSync(userFile, 'utf8')).toBe('profile v1\n')
    memory.writeUser('profile v2')
    expect(memory.readUser()).toBe('profile v2\n')
    expect(memory.versions.list({ target: 'user' }).length).toBe(1)
  })
})

// ── test_memory_versions.py ──

describe('MemoryVersionStore (test_memory_versions.py)', () => {
  it('rejects unknown serialized version targets instead of silently coercing to memory', () => {
    expect(() =>
      memoryVersionFromDict({
        id: 'memv_bad',
        target: 'global',
        relPath: 'memory/MEMORY.local.md',
      }),
    ).toThrow(/unknown memory version target/)
  })

  it('snapshots and restores', () => {
    const root = tmp('emperor-memv-')
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, 'MEMORY.local.md')
    const userFile = join(root, 'USER.local.md')
    writeFileSync(memoryFile, 'v1\n', 'utf8')
    const store = new MemoryVersionStore(root, memoryDir, userFile)

    const v1 = store.snapshotPath(memoryFile, { reason: 'first' })
    expect(v1).not.toBeNull()
    expect(v1!.target).toBe('memory')
    writeFileSync(memoryFile, 'v2\n', 'utf8')
    store.snapshotPath(memoryFile, { reason: 'second' })

    expect(store.list().length).toBe(2)
    const restored = store.restore(v1!.id)
    expect(restored.content).toBe('v1\n')
    expect(readFileSync(memoryFile, 'utf8')).toBe('v1\n')
  })

  it('skips duplicate latest snapshot', () => {
    const root = tmp('emperor-memv-dup-')
    const memoryDir = join(root, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    const memoryFile = join(memoryDir, 'MEMORY.local.md')
    writeFileSync(memoryFile, 'same\n', 'utf8')
    const store = new MemoryVersionStore(
      root,
      memoryDir,
      join(root, 'USER.local.md'),
    )
    const v1 = store.snapshotPath(memoryFile)
    const v2 = store.snapshotPath(memoryFile)
    expect(v1!.id).toBe(v2!.id)
    expect(store.list().length).toBe(1)
  })

  it('MemoryStore writes create versions', () => {
    const root = tmp('emperor-memv-store-')
    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'USER.local.md'),
    )
    memory.writeMemory('first memory')
    memory.writeMemory('second memory')
    const versions = memory.versions.list({ target: 'memory' })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(memory.readMemory()).toBe('second memory\n')
  })
})
