import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMutationCoordinator } from './mutation-coordinator'

describe('WorkspaceMutationCoordinator', () => {
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
