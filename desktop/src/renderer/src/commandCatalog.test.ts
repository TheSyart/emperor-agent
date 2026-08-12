import { describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor } from '@emperor/core/api'
import { createCommandCatalogLoader } from './commandCatalog'

const modelCommand = { id: 'builtin.model' } as CommandDescriptor
const skillCommand = { id: 'skill.user.agent-reach' } as CommandDescriptor

describe('command catalog loader', () => {
  it('coalesces concurrent refreshes into one Core request', async () => {
    let resolveList!: (commands: CommandDescriptor[]) => void
    const list = vi.fn(
      () =>
        new Promise<CommandDescriptor[]>((resolve) => {
          resolveList = resolve
        }),
    )
    const apply = vi.fn()
    const loader = createCommandCatalogLoader({
      currentSessionId: () => 'session-1',
      list,
      apply,
    })

    const first = loader.refresh()
    const second = loader.refresh()
    resolveList([modelCommand, skillCommand])
    await Promise.all([first, second])

    expect(list).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith([modelCommand, skillCommand])
  })

  it('keeps the last successful catalog when refresh fails', async () => {
    const apply = vi.fn()
    const onError = vi.fn()
    const loader = createCommandCatalogLoader({
      currentSessionId: () => 'session-1',
      list: vi.fn(async () => {
        throw new Error('offline')
      }),
      apply,
      onError,
    })

    await loader.refresh()

    expect(apply).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'offline' }),
    )
  })

  it('does not apply a result after the active session changes', async () => {
    let sessionId = 'session-1'
    let resolveList!: (commands: CommandDescriptor[]) => void
    const apply = vi.fn()
    const loader = createCommandCatalogLoader({
      currentSessionId: () => sessionId,
      list: () =>
        new Promise<CommandDescriptor[]>((resolve) => {
          resolveList = resolve
        }),
      apply,
    })

    const refresh = loader.refresh()
    sessionId = 'session-2'
    resolveList([modelCommand])
    await refresh

    expect(apply).not.toHaveBeenCalled()
  })

  it('starts a fresh request for a new session after an older refresh settles', async () => {
    let sessionId = 'session-1'
    let resolveFirst!: (commands: CommandDescriptor[]) => void
    const apply = vi.fn()
    const list = vi.fn((owner: string) => {
      if (owner === 'session-1') {
        return new Promise<CommandDescriptor[]>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve([skillCommand])
    })
    const loader = createCommandCatalogLoader({
      currentSessionId: () => sessionId,
      list,
      apply,
    })

    const first = loader.refresh()
    sessionId = 'session-2'
    const second = loader.refresh()
    resolveFirst([modelCommand])
    await Promise.all([first, second])

    expect(list).toHaveBeenNthCalledWith(1, 'session-1')
    expect(list).toHaveBeenNthCalledWith(2, 'session-2')
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith([skillCommand])
  })
})
