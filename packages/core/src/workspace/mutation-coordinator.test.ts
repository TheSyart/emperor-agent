import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceMutationCoordinator,
  workspaceMutationDomain,
} from './mutation-coordinator'

describe('WorkspaceMutationCoordinator', () => {
  it('holds renderer Git mutations behind non-Git shared-exclusive and real tool writers', async () => {
    const coordinator = new WorkspaceMutationCoordinator()
    const root = mkdtempSync(join(tmpdir(), 'emperor-nongit-lease-'))
    const tool = await coordinator.acquireWriter(root, 'tool')
    const exclusive = coordinator.resources.acquire({
      keys: [workspaceMutationDomain(root)],
      mode: 'exclusive',
      owner: 'external',
    })
    let externalAcquired = false
    void exclusive.then(() => {
      externalAcquired = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(externalAcquired).toBe(false)
    tool.release()
    const lease = await exclusive
    const mutate = vi.fn()
    const renderer = coordinator.runExclusive(root, 'renderer_git', mutate)
    await new Promise((resolve) => setImmediate(resolve))
    expect(mutate).not.toHaveBeenCalled()
    lease.release()
    await renderer
    expect(mutate).toHaveBeenCalledOnce()
  })
  it('serializes Agent and Renderer Git mutations for one workspace', async () => {
    const coordinator = new WorkspaceMutationCoordinator()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = coordinator.runExclusive(
      '/workspace/a',
      'renderer_git',
      async () => {
        order.push('git:start')
        await firstGate
        order.push('git:end')
      },
    )
    const second = coordinator.runExclusive(
      '/workspace/a',
      'agent',
      async () => {
        order.push('agent:start')
      },
    )

    await vi.waitFor(() => expect(order).toEqual(['git:start']))
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['git:start', 'git:end', 'agent:start'])
  })

  it('allows different workspaces to progress independently', async () => {
    const coordinator = new WorkspaceMutationCoordinator()
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = coordinator.runExclusive(
      '/workspace/a',
      'agent',
      async () => {
        await gate
      },
    )
    await coordinator.runExclusive('/workspace/b', 'renderer_git', async () => {
      seen.push('independent')
    })

    expect(seen).toEqual(['independent'])
    release()
    await first
  })

  it('never runs a queued mutation after its turn is cancelled', async () => {
    const coordinator = new WorkspaceMutationCoordinator()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = coordinator.runExclusive(
      '/workspace/a',
      'agent',
      async () => {
        await firstGate
      },
    )
    const controller = new AbortController()
    const cancelledAction = vi.fn()
    const cancelled = coordinator.runExclusive(
      '/workspace/a',
      'agent',
      cancelledAction,
      controller.signal,
    )
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })

    const finalAction = vi.fn()
    const final = coordinator.runExclusive('/workspace/a', 'agent', finalAction)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(cancelledAction).not.toHaveBeenCalled()
    expect(finalAction).not.toHaveBeenCalled()

    releaseFirst()
    await Promise.all([first, final])
    expect(finalAction).toHaveBeenCalledOnce()
  })

  it('serializes sibling projects that share one Git worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-mutation-domain-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    mkdirSync(join(root, 'apps', 'api'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const coordinator = new WorkspaceMutationCoordinator()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = coordinator.runExclusive(
      join(root, 'apps', 'web'),
      'agent',
      async () => {
        order.push('web:start')
        await firstGate
        order.push('web:end')
      },
    )
    const second = coordinator.runExclusive(
      join(root, 'apps', 'api'),
      'renderer_git',
      async () => {
        order.push('api:start')
      },
    )

    await vi.waitFor(() => expect(order).toEqual(['web:start']))
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['web:start', 'web:end', 'api:start'])
  })
})

describe('waiting for a workspace a child holds (AGT-06)', () => {
  it('reports after the notice delay who holds the workspace, and ends the notice when the lease comes', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new WorkspaceMutationCoordinator()
      const root = mkdtempSync(join(tmpdir(), 'emperor-wait-notice-'))
      const child = await coordinator.resources.acquire({
        keys: [workspaceMutationDomain(root)],
        mode: 'exclusive',
        owner: 'dlg-child',
      })
      const ended = vi.fn()
      const onWait = vi.fn((_blockers: string[]) => ended)
      const waiting = coordinator.acquireWriterWithNotice(root, 'call-1', {
        onWait,
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(onWait).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onWait).toHaveBeenCalledWith(['dlg-child'])
      child.release()
      const lease = await waiting
      expect(ended).toHaveBeenCalledTimes(1)
      lease.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing for a short wait', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new WorkspaceMutationCoordinator()
      const root = mkdtempSync(join(tmpdir(), 'emperor-wait-short-'))
      const child = await coordinator.resources.acquire({
        keys: [workspaceMutationDomain(root)],
        mode: 'exclusive',
        owner: 'dlg-child',
      })
      const onWait = vi.fn()
      const waiting = coordinator.acquireWriterWithNotice(root, 'call-1', {
        onWait,
      })
      await vi.advanceTimersByTimeAsync(2_000)
      child.release()
      ;(await waiting).release()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(onWait).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
