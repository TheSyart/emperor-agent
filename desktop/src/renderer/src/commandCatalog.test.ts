import { describe, expect, it, vi } from 'vitest'
import type { CommandCompletion, CommandDescriptor } from '@emperor/core/api'
import {
  commandCatalogOwner,
  createCommandCatalogLoader,
  createCommandCompleter,
  type CommandCatalogOwner,
} from './commandCatalog'

const modelCommand = { id: 'builtin.model' } as CommandDescriptor
const skillCommand = { id: 'skill.user.agent-reach' } as CommandDescriptor

const session = (sessionId: string): CommandCatalogOwner => ({ sessionId })

/** A start-page Build draft on `path` (FIX-14). */
function buildDraft(id: string, path: string): CommandCatalogOwner {
  return {
    sessionId: id,
    draftSession: {
      mode: 'build',
      project: { project_id: path, project_path: path, project_name: 'app' },
    },
  }
}

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
      currentOwner: () => session('session-1'),
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
      currentOwner: () => session('session-1'),
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
    let owner = session('session-1')
    let resolveList!: (commands: CommandDescriptor[]) => void
    const apply = vi.fn()
    const loader = createCommandCatalogLoader({
      currentOwner: () => owner,
      list: () =>
        new Promise<CommandDescriptor[]>((resolve) => {
          resolveList = resolve
        }),
      apply,
    })

    const refresh = loader.refresh()
    owner = session('session-2')
    resolveList([modelCommand])
    await refresh

    expect(apply).not.toHaveBeenCalled()
  })

  it('starts a fresh request for a new session after an older refresh settles', async () => {
    let owner = session('session-1')
    let resolveFirst!: (commands: CommandDescriptor[]) => void
    const apply = vi.fn()
    const list = vi.fn((target: CommandCatalogOwner) => {
      if (target.sessionId === 'session-1') {
        return new Promise<CommandDescriptor[]>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve([skillCommand])
    })
    const loader = createCommandCatalogLoader({
      currentOwner: () => owner,
      list,
      apply,
    })

    const first = loader.refresh()
    owner = session('session-2')
    const second = loader.refresh()
    resolveFirst([modelCommand])
    await Promise.all([first, second])

    expect(list).toHaveBeenNthCalledWith(1, session('session-1'))
    expect(list).toHaveBeenNthCalledWith(2, session('session-2'))
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith([skillCommand])
  })

  // FIX-14 test 5: the start page lists its own commands and Skills.
  it('lists a draft with its draft context, and never clears the list for want of a session', async () => {
    let owner: CommandCatalogOwner | null = null
    const apply = vi.fn()
    const list = vi.fn(async () => [modelCommand, skillCommand])
    const loader = createCommandCatalogLoader({
      currentOwner: () => owner,
      list,
      apply,
    })

    // Nothing on screen yet (start-up): the shown list stays as it is.
    await loader.refresh()
    expect(list).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()

    owner = buildDraft('draft:1', '/work/app')
    await loader.refresh()
    expect(list).toHaveBeenCalledWith(buildDraft('draft:1', '/work/app'))
    expect(apply).toHaveBeenCalledWith([modelCommand, skillCommand])
    expect(apply).not.toHaveBeenCalledWith([])
  })

  it('asks again when the draft’s project changes, and drops the stale answer', async () => {
    let owner = buildDraft('draft:1', '/work/a')
    const pending: Array<(commands: CommandDescriptor[]) => void> = []
    const apply = vi.fn()
    const list = vi.fn(
      () =>
        new Promise<CommandDescriptor[]>((resolve) => {
          pending.push(resolve)
        }),
    )
    const loader = createCommandCatalogLoader({
      currentOwner: () => owner,
      list,
      apply,
    })

    const first = loader.refresh()
    owner = buildDraft('draft:1', '/work/b')
    const second = loader.refresh()
    pending[0]!([modelCommand])
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    pending[1]!([skillCommand])
    await Promise.all([first, second])

    expect(list).toHaveBeenNthCalledWith(1, buildDraft('draft:1', '/work/a'))
    expect(list).toHaveBeenNthCalledWith(2, buildDraft('draft:1', '/work/b'))
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith([skillCommand])
  })
})

describe('the owner of the composer’s catalog (FIX-14)', () => {
  const row = {
    mode: 'build' as const,
    project_id: 'p1',
    project_path: '/work/app',
    project_name: 'app',
  }

  it('names a draft by its id with the mode and project its session will get', () => {
    expect(commandCatalogOwner('draft:1', row)).toEqual({
      sessionId: 'draft:1',
      draftSession: {
        mode: 'build',
        project: {
          project_id: 'p1',
          project_path: '/work/app',
          project_name: 'app',
        },
      },
    })
    expect(commandCatalogOwner('draft:2', { ...row, mode: 'chat' })).toEqual({
      sessionId: 'draft:2',
      draftSession: { mode: 'chat', project: null },
    })
    expect(commandCatalogOwner('draft:3', undefined)).toEqual({
      sessionId: 'draft:3',
      draftSession: { mode: 'chat', project: null },
    })
  })

  it('names a session by its id alone, and nothing when none is shown', () => {
    expect(commandCatalogOwner('session-1', row)).toEqual({
      sessionId: 'session-1',
    })
    expect(commandCatalogOwner('', undefined)).toBeNull()
  })
})

describe('slash command completion (FIX-14 test 6)', () => {
  const completions: CommandCompletion[] = [
    { value: 'read-only', label: '只读', kind: 'permission_preset' },
  ]

  it('completes on a draft with its draft context', async () => {
    const complete = vi.fn(async () => completions)
    const completer = createCommandCompleter({
      currentOwner: () => buildDraft('draft:1', '/work/app'),
      complete,
    })

    await expect(completer('builtin.permissions', 're', 2)).resolves.toEqual(
      completions,
    )
    expect(complete).toHaveBeenCalledWith({
      ...buildDraft('draft:1', '/work/app'),
      commandId: 'builtin.permissions',
      rawArgs: 're',
      cursor: 2,
    })
  })

  it('offers nothing while no session is shown', async () => {
    const complete = vi.fn(async () => completions)
    const completer = createCommandCompleter({
      currentOwner: () => null,
      complete,
    })
    await expect(completer('builtin.model', '', 0)).resolves.toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })
})
