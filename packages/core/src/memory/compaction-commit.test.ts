import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompactionPatchCommitter } from './compaction-commit'
import { CompactionCursorStore, CompactionLedger } from './compaction-ledger'
import { memoryContentHash, type MemoryPatch } from './patch'
import { MemoryVersionStore } from './versions'
import type {
  ActiveMemoryBinding,
  CompactionPatchBundle,
  CompactionRunRecord,
} from './compaction-models'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const binding: ActiveMemoryBinding = {
  profile: {
    scope: { kind: 'user_profile' },
    readable: true,
    writable: true,
    path: '/state/memory/profile/USER.local.md',
  },
  longTerm: {
    scope: { kind: 'project', projectId: 'project_1' },
    readable: true,
    writable: true,
    path: '/state/projects/project_1/AGENTS.local.md',
  },
  episode: {
    scope: { kind: 'episode', date: '2026-07-06' },
    readable: false,
    writable: true,
    path: '/state/memory/2026-07-06.md',
  },
}

const input: CompactionRunRecord['input'] = {
  historyHash: 'history-hash',
  historyCount: 8,
  userProfileHash: 'profile-hash',
  projectMemoryHash: 'project-hash',
  episodeHash: 'episode-hash',
}

function paths(root: string): {
  memoryDir: string
  userFile: string
  globalFile: string
  projectFile: string
  episodeFile: string
} {
  return {
    memoryDir: join(root, 'memory'),
    userFile: join(root, 'memory', 'profile', 'USER.local.md'),
    globalFile: join(root, 'memory', 'MEMORY.local.md'),
    projectFile: join(root, 'projects', 'project_1', 'AGENTS.local.md'),
    episodeFile: join(root, 'memory', '2026-07-06.md'),
  }
}

function seed(root: string): ReturnType<typeof paths> {
  const p = paths(root)
  mkdirSync(join(root, 'memory', 'profile'), { recursive: true })
  mkdirSync(join(root, 'projects', 'project_1'), { recursive: true })
  writeFileSync(p.userFile, '# User Profile\n\n## Stable Preferences\n', 'utf8')
  writeFileSync(
    p.globalFile,
    '# Global Long-Term Memory\n\n## Open Questions\n',
    'utf8',
  )
  writeFileSync(
    p.projectFile,
    '# Project Memory\n\n## Build Commands\n',
    'utf8',
  )
  writeFileSync(p.episodeFile, '# Episode: 2026-07-06\n\n## Summary\n', 'utf8')
  return p
}

function patch(
  target: MemoryPatch['target'],
  current: string,
  section: string,
  item: string,
): MemoryPatch {
  return {
    target,
    baseVersion: 1,
    baseHash: memoryContentHash(current),
    operations: [{ op: 'append_section_item', section, item }],
    rationale: `append ${section}`,
  }
}

function bundle(root: string, p = paths(root)): CompactionPatchBundle {
  return {
    compactionId: 'compact_1',
    sessionId: 'session_1',
    mode: 'build',
    projectId: 'project_1',
    range: { fromSeq: 1, toSeq: 8 },
    patches: {
      userProfilePatch: patch(
        { kind: 'user_profile' },
        readFileSync(p.userFile, 'utf8'),
        'Stable Preferences',
        '- Prefers direct answers',
      ),
      projectMemoryPatch: patch(
        { kind: 'project', projectId: 'project_1' },
        readFileSync(p.projectFile, 'utf8'),
        'Build Commands',
        '- make check',
      ),
      episodePatch: patch(
        { kind: 'episode', date: '2026-07-06' },
        readFileSync(p.episodeFile, 'utf8'),
        'Summary',
        '- Compaction patch committed',
      ),
    },
    decisions: [],
    discarded: [],
  }
}

describe('CompactionPatchCommitter', () => {
  it('applies all scoped patches, records ledger output, and advances the cursor after success', () => {
    const root = tmp('emperor-compaction-commit-')
    const p = seed(root)
    const versions = new MemoryVersionStore(root, p.memoryDir, p.userFile)
    const cursorStore = new CompactionCursorStore(root)
    const ledger = new CompactionLedger(root)
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      versions,
      cursorStore,
      ledger,
    })

    const result = committer.commitBundle(bundle(root, p), {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(p.userFile, 'utf8')).toContain(
      '- Prefers direct answers',
    )
    expect(readFileSync(p.projectFile, 'utf8')).toContain('- make check')
    expect(readFileSync(p.episodeFile, 'utf8')).toContain(
      '- Compaction patch committed',
    )
    expect(cursorStore.readOrInit('session_1')).toMatchObject({
      status: 'active',
      compactedUntilSeq: 8,
      lastCompactionId: 'compact_1',
    })
    expect(versions.list({ target: 'user' })).toHaveLength(1)
    expect(versions.list({ target: 'project' })).toHaveLength(1)
    expect(versions.list({ target: 'episode' })).toHaveLength(1)

    const index = ledger.readIndex()
    expect(index.compact_1).toMatchObject({
      status: 'applied',
      range: { fromSeq: 1, toSeq: 8 },
    })
    expect(
      index.compact_1?.output?.targetVersions.map(
        (target) => target.scope.kind,
      ),
    ).toEqual(['episode', 'user_profile', 'project'])
  })

  it('records failed validation without mutating memory or advancing the cursor', () => {
    const root = tmp('emperor-compaction-commit-fail-')
    const p = seed(root)
    const originalUser = readFileSync(p.userFile, 'utf8')
    const versions = new MemoryVersionStore(root, p.memoryDir, p.userFile)
    const cursorStore = new CompactionCursorStore(root)
    const ledger = new CompactionLedger(root)
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      versions,
      cursorStore,
      ledger,
    })
    const badBundle = bundle(root, p)
    badBundle.patches.userProfilePatch = {
      ...badBundle.patches.userProfilePatch!,
      baseHash: 'stale',
    }

    const result = committer.commitBundle(badBundle, {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain('base_hash_mismatch')
    expect(readFileSync(p.userFile, 'utf8')).toBe(originalUser)
    expect(cursorStore.readOrInit('session_1')).toMatchObject({
      status: 'active',
      compactedUntilSeq: 0,
    })
    expect(versions.list({ target: 'user' })).toHaveLength(0)
    expect(
      existsSync(join(root, 'memory', 'compaction', 'patches.jsonl')),
    ).toBe(false)
    expect(ledger.readIndex().compact_1).toMatchObject({
      status: 'failed',
      error: { validationErrors: ['base_hash_mismatch'] },
    })
  })

  it('restores the previous cursor when validation fails after marking compacting', () => {
    const root = tmp('emperor-compaction-commit-cursor-restore-')
    const p = seed(root)
    const cursorStore = new CompactionCursorStore(root)
    cursorStore.markCompacting('session_1', {
      lastHistorySeq: 3,
      compactionId: 'compact_previous',
    })
    cursorStore.advance('session_1', {
      compactedUntilSeq: 3,
      compactionId: 'compact_previous',
      lastHistorySeq: 3,
    })
    const previous = cursorStore.readOrInit('session_1')
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      cursorStore,
      ledger: new CompactionLedger(root),
    })
    const badBundle = bundle(root, p)
    badBundle.patches.userProfilePatch = {
      ...badBundle.patches.userProfilePatch!,
      baseHash: 'stale',
    }

    const result = committer.commitBundle(badBundle, {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(false)
    expect(cursorStore.readOrInit('session_1')).toEqual(previous)
  })

  it('rolls back earlier file writes when a later scoped patch write fails', () => {
    const root = tmp('emperor-compaction-commit-rollback-')
    const p = seed(root)
    const originalUser = readFileSync(p.userFile, 'utf8')
    const originalProject = readFileSync(p.projectFile, 'utf8')
    const originalEpisode = readFileSync(p.episodeFile, 'utf8')
    const versions = new MemoryVersionStore(root, p.memoryDir, p.userFile)
    const cursorStore = new CompactionCursorStore(root)
    const ledger = new CompactionLedger(root)
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      versions,
      cursorStore,
      ledger,
      writeText: (path, content) => {
        if (path === p.projectFile)
          throw new Error('simulated project write failure')
        writeFileSync(path, content, 'utf8')
      },
    })

    const result = committer.commitBundle(bundle(root, p), {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain(
      'simulated project write failure',
    )
    expect(readFileSync(p.userFile, 'utf8')).toBe(originalUser)
    expect(readFileSync(p.projectFile, 'utf8')).toBe(originalProject)
    expect(readFileSync(p.episodeFile, 'utf8')).toBe(originalEpisode)
    expect(cursorStore.readOrInit('session_1')).toMatchObject({
      status: 'active',
      compactedUntilSeq: 0,
    })
    expect(ledger.readIndex().compact_1).toMatchObject({
      status: 'failed',
      error: { code: 'apply_failed' },
    })
  })

  it('rolls back prepared file writes when recording the applied ledger entry fails', () => {
    class FailingAppliedLedger extends CompactionLedger {
      override recordApplied(record: CompactionRunRecord): CompactionRunRecord {
        throw new Error(
          `simulated applied ledger failure for ${record.compactionId}`,
        )
      }
    }
    const root = tmp('emperor-compaction-commit-ledger-fail-')
    const p = seed(root)
    const originalUser = readFileSync(p.userFile, 'utf8')
    const originalProject = readFileSync(p.projectFile, 'utf8')
    const originalEpisode = readFileSync(p.episodeFile, 'utf8')
    const cursorStore = new CompactionCursorStore(root)
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      cursorStore,
      ledger: new FailingAppliedLedger(root),
    })

    const result = committer.commitBundle(bundle(root, p), {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain(
      'simulated applied ledger failure',
    )
    expect(readFileSync(p.userFile, 'utf8')).toBe(originalUser)
    expect(readFileSync(p.projectFile, 'utf8')).toBe(originalProject)
    expect(readFileSync(p.episodeFile, 'utf8')).toBe(originalEpisode)
    expect(cursorStore.readOrInit('session_1')).toMatchObject({
      status: 'active',
      lastHistorySeq: 0,
      compactedUntilSeq: 0,
      archivedUntilSeq: 0,
    })
  })

  it('rolls back prepared file writes and restores the cursor when cursor advance fails', () => {
    class FailingAdvanceCursorStore extends CompactionCursorStore {
      override advance(): ReturnType<CompactionCursorStore['advance']> {
        throw new Error('simulated cursor advance failure')
      }
    }
    const root = tmp('emperor-compaction-commit-cursor-fail-')
    const p = seed(root)
    const originalUser = readFileSync(p.userFile, 'utf8')
    const originalProject = readFileSync(p.projectFile, 'utf8')
    const originalEpisode = readFileSync(p.episodeFile, 'utf8')
    const cursorStore = new FailingAdvanceCursorStore(root)
    cursorStore.markCompacting('session_1', {
      lastHistorySeq: 2,
      compactionId: 'compact_previous',
    })
    const previous = cursorStore.markActive('session_1')
    const ledger = new CompactionLedger(root)
    const committer = new CompactionPatchCommitter({
      root,
      memoryDir: p.memoryDir,
      userFile: p.userFile,
      cursorStore,
      ledger,
    })

    const result = committer.commitBundle(bundle(root, p), {
      trigger: { kind: 'manual' },
      activeMemoryBinding: binding,
      input,
    })

    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toContain(
      'simulated cursor advance failure',
    )
    expect(readFileSync(p.userFile, 'utf8')).toBe(originalUser)
    expect(readFileSync(p.projectFile, 'utf8')).toBe(originalProject)
    expect(readFileSync(p.episodeFile, 'utf8')).toBe(originalEpisode)
    expect(cursorStore.readOrInit('session_1')).toEqual(previous)
    expect(ledger.readIndex().compact_1).toMatchObject({ status: 'failed' })
  })
})
