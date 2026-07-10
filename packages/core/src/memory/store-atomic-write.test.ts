/**
 * MemoryStore.writeMemory/writeUser 原子写入回归测试 (audit P0-4)。
 * 审计发现：这两个写入路径此前直接 `writeFileSync` 覆盖 MEMORY.local.md/USER.local.md，
 * 崩溃/断电可截断这两个"常驻上下文"的核心记忆文件。修复后应改为 tmp+rename，
 * 与同一类里的 `writeCheckpoint` 保持一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const renameCalls: Array<[string, string]> = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (
      src: Parameters<typeof actual.renameSync>[0],
      dest: Parameters<typeof actual.renameSync>[1],
    ) => {
      renameCalls.push([String(src), String(dest)])
      return actual.renameSync(src, dest)
    },
  }
})

import { MemoryStore } from './store'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

beforeEach(() => {
  renameCalls.length = 0
})

describe('MemoryStore atomic writes (audit P0-4)', () => {
  it('writeMemory goes through tmp+rename, not a direct truncating write', () => {
    const root = tmp('emperor-mem-atomic-')
    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'USER.local.md'),
    )

    memory.writeMemory('long-term fact')

    const memoryRename = renameCalls.find(
      ([, dest]) => dest === memory.memoryFile,
    )
    expect(memoryRename).toBeTruthy()
    expect(memoryRename![0]).toContain('.tmp')
    expect(memory.readMemory()).toBe('long-term fact\n')
  })

  it('writeUser goes through tmp+rename, not a direct truncating write', () => {
    const root = tmp('emperor-mem-atomic-')
    const memory = new MemoryStore(
      join(root, 'memory'),
      join(root, 'USER.local.md'),
    )

    memory.writeUser('user preference')

    const userRename = renameCalls.find(([, dest]) => dest === memory.userFile)
    expect(userRename).toBeTruthy()
    expect(userRename![0]).toContain('.tmp')
    expect(memory.readUser()).toBe('user preference\n')
  })
})
