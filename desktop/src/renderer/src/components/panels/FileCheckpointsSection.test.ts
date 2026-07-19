// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FileCheckpointsSection from './FileCheckpointsSection.vue'
import { core } from '../../api/http'

vi.mock('../../api/http', () => ({ core: vi.fn() }))

const coreMock = vi.mocked(core)
let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  coreMock.mockReset()
})

describe('FileCheckpointsSection', () => {
  it('requires preview before sending an explicit rewind confirmation', async () => {
    const checkpoint = {
      version: 1 as const,
      id: 'fcp_0123456789abcdef01234567',
      sessionId: 'session-one',
      turnId: 'turn-one',
      toolCallId: 'call-one',
      toolName: 'edit_file',
      workspaceRoot: '/private/workspace',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      status: 'ready' as const,
      storedBytes: 12,
      quotaTruncated: false,
      prepared: [],
      changes: [
        {
          path: 'src/a.ts',
          kind: 'modify' as const,
          before: {
            state: 'file' as const,
            hash: 'a'.repeat(64),
            bytes: 6,
            mode: 0o644,
            storage: 'inline_text' as const,
            content: 'before',
          },
          after: {
            state: 'file' as const,
            hash: 'b'.repeat(64),
            bytes: 5,
            mode: 0o644,
            storage: 'inline_text' as const,
            content: 'after',
          },
        },
      ],
    }
    coreMock
      .mockResolvedValueOnce({
        enabled: true,
        sessionId: 'session-one',
        checkpoints: [checkpoint],
      } as never)
      .mockResolvedValueOnce({
        checkpoint,
        canRewind: true,
        conflicts: [],
      } as never)
      .mockResolvedValueOnce({ ...checkpoint, status: 'rewound' } as never)
      .mockResolvedValueOnce({
        enabled: true,
        sessionId: 'session-one',
        checkpoints: [{ ...checkpoint, status: 'rewound' }],
      } as never)

    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(FileCheckpointsSection, { sessionId: 'session-one' }),
    ).mount(container)
    await nextTick()
    await nextTick()

    expect(container.textContent).toContain('src/a.ts')
    expect(container.querySelector('[data-action="confirm-rewind"]')).toBeNull()
    container
      .querySelector<HTMLButtonElement>('[data-action="preview-rewind"]')!
      .click()
    await nextTick()
    await nextTick()
    expect(coreMock).toHaveBeenNthCalledWith(2, 'fileCheckpoints.preview', {
      sessionId: 'session-one',
      checkpointId: checkpoint.id,
    })

    container
      .querySelector<HTMLButtonElement>('[data-action="confirm-rewind"]')!
      .click()
    await nextTick()
    await nextTick()
    expect(coreMock).toHaveBeenNthCalledWith(3, 'fileCheckpoints.rewind', {
      sessionId: 'session-one',
      checkpointId: checkpoint.id,
      confirmed: true,
    })
  })

  it('shows conflict details and never offers confirmation', async () => {
    const checkpoint = {
      id: 'fcp_0123456789abcdef01234567',
      toolName: 'write_file',
      status: 'ready',
      createdAt: '2026-07-19T00:00:00.000Z',
      storedBytes: 1,
      quotaTruncated: false,
      changes: [{ path: 'changed.txt', kind: 'modify' }],
    }
    coreMock
      .mockResolvedValueOnce({
        enabled: true,
        sessionId: 'session-one',
        checkpoints: [checkpoint],
      } as never)
      .mockResolvedValueOnce({
        checkpoint,
        canRewind: false,
        conflicts: [
          {
            path: 'changed.txt',
            reason: 'current_state_changed',
            expectedHash: 'a'.repeat(64),
            actualHash: 'b'.repeat(64),
          },
        ],
      } as never)

    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(FileCheckpointsSection, { sessionId: 'session-one' }),
    ).mount(container)
    await nextTick()
    await nextTick()
    container
      .querySelector<HTMLButtonElement>('[data-action="preview-rewind"]')!
      .click()
    await nextTick()
    await nextTick()

    expect(container.textContent).toContain('工作区内容已变化')
    expect(container.textContent).toContain('changed.txt')
    expect(container.querySelector('[data-action="confirm-rewind"]')).toBeNull()
  })

  it('requires a separate Git risk confirmation and selects stash only when preview requires it', async () => {
    const checkpoint = {
      id: 'fcp_0123456789abcdef01234567',
      toolName: 'edit_file',
      status: 'ready',
      createdAt: '2026-07-19T00:00:00.000Z',
      storedBytes: 10,
      quotaTruncated: false,
      changes: [{ path: 'src/a.ts', kind: 'modify' }],
      gitCheckpoint: {
        version: 1,
        status: 'captured',
        reason: 'ready',
        head: 'a'.repeat(40),
        branch: 'refs/heads/main',
        indexFingerprint: 'b'.repeat(64),
        stagedPaths: [],
        capturedAt: '2026-07-19T00:00:00.000Z',
        repository: {
          rootDigest: 'c'.repeat(64),
          gitDirDigest: 'd'.repeat(64),
          commonDirDigest: 'd'.repeat(64),
        },
      },
    }
    const gitPreview = {
      available: true,
      canRewind: true,
      revision: 'e'.repeat(64),
      reason: 'ready',
      targetHead: 'a'.repeat(40),
      currentHead: 'f'.repeat(40),
      commitsToRewind: 2,
      managedDirtyPaths: ['src/a.ts'],
      unrelatedDirtyPaths: ['notes.txt'],
      requiresStash: true,
      stashSafe: true,
      dirtyBytes: 12,
    }
    coreMock
      .mockResolvedValueOnce({
        enabled: true,
        gitRewindMode: 'on',
        sessionId: 'session-one',
        reconciliation: { recovered: 0, discarded: 0, failed: 0 },
        gitReconciliation: { completed: 0, interrupted: 0, unchanged: 0 },
        checkpoints: [checkpoint],
      } as never)
      .mockResolvedValueOnce({
        checkpoint,
        canRewind: true,
        conflicts: [],
        git: gitPreview,
      } as never)
      .mockResolvedValueOnce({
        checkpoint: { ...checkpoint, status: 'rewound' },
        git: {
          status: 'completed',
          rescue: {
            headRef: 'refs/emperor-agent/rewind/grw_one/head',
            indexRef: 'refs/emperor-agent/rewind/grw_one/index',
            stashRef: 'refs/emperor-agent/rewind/grw_one/stash',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        enabled: true,
        gitRewindMode: 'on',
        sessionId: 'session-one',
        reconciliation: { recovered: 0, discarded: 0, failed: 0 },
        gitReconciliation: { completed: 0, interrupted: 0, unchanged: 0 },
        checkpoints: [{ ...checkpoint, status: 'rewound' }],
      } as never)

    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(FileCheckpointsSection, { sessionId: 'session-one' }),
    ).mount(container)
    await nextTick()
    await nextTick()
    container
      .querySelector<HTMLButtonElement>('[data-action="preview-rewind"]')!
      .click()
    await nextTick()
    await nextTick()

    expect(container.textContent).toContain('2 个提交')
    expect(container.textContent).toContain('notes.txt')
    container
      .querySelector<HTMLButtonElement>('[data-action="confirm-git-rewind"]')!
      .click()
    await nextTick()
    await nextTick()
    expect(coreMock).toHaveBeenNthCalledWith(3, 'fileCheckpoints.rewindGit', {
      sessionId: 'session-one',
      checkpointId: checkpoint.id,
      confirmed: true,
      confirmedGitRisk: true,
      previewRevision: gitPreview.revision,
      dirtyStrategy: 'stash',
    })
    expect(container.textContent).toContain(
      'refs/emperor-agent/rewind/grw_one/head',
    )
  })

  it('surfaces isolated corrupt Git transaction journals without offering recovery mutation', async () => {
    coreMock.mockResolvedValueOnce({
      enabled: true,
      gitRewindMode: 'on',
      sessionId: 'session-one',
      reconciliation: { recovered: 0, discarded: 0, failed: 0 },
      gitReconciliation: { completed: 0, interrupted: 0, unchanged: 0 },
      gitDiagnostics: {
        requestedMode: 'on',
        corruptJournals: 1,
        lastCorruptBackup:
          '/private/state/git-rewind/transactions.v1.json.corrupt-1',
      },
      checkpoints: [],
    } as never)

    container = document.createElement('div')
    document.body.append(container)
    createApp(() =>
      h(FileCheckpointsSection, { sessionId: 'session-one' }),
    ).mount(container)
    await nextTick()
    await nextTick()

    expect(container.textContent).toContain('已隔离 1 个损坏的 Git')
    expect(container.textContent).toContain('transactions.v1.json.corrupt-1')
    expect(
      container.querySelector('[data-action="confirm-git-rewind"]'),
    ).toBeNull()
  })
})
