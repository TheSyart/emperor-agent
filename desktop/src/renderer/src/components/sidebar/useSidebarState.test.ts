import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

import { useSidebarState } from './useSidebarState'
import { defaultSidebarState } from '../../runtime/sidebarModel'

// BUG-06: the 置顶 / 项目 / 对话 sections fold, and Core keeps which ones
// (sidebar_state.json `collapsed_sections`, like `collapsed_project_ids`).

/** What a fake Core keeps on disk between sidebar.get and sidebar.patch. */
let saved: Record<string, unknown>
const showToast = vi.fn()

beforeEach(() => {
  saved = {}
  showToast.mockReset()
  core.mockReset()
  core.mockImplementation(async (op: string, input?: object) => {
    if (op === 'sidebar.get') return { ...defaultSidebarState, ...saved }
    if (op === 'sidebar.patch') {
      saved = { ...saved, ...input }
      return { ...defaultSidebarState, ...saved }
    }
    throw new Error(`unexpected ${op}`)
  })
})

function layout() {
  return useSidebarState({ sessions: ref([]), projects: ref([]), showToast })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('useSidebarState sections (BUG-06)', () => {
  it('3 · folds a section at once, writes it to Core and reads it back after a restart', async () => {
    const first = layout()
    await first.load()
    expect(first.isSectionCollapsed('chats')).toBe(false)
    first.toggleSection('chats')
    expect(first.isSectionCollapsed('chats')).toBe(true)
    await flush()
    expect(core).toHaveBeenCalledWith(
      'sidebar.patch',
      expect.objectContaining({ collapsed_sections: ['chats'] }),
    )

    const restarted = layout()
    await restarted.load()
    expect(restarted.isSectionCollapsed('chats')).toBe(true)
    expect(restarted.isSectionCollapsed('projects')).toBe(false)
    restarted.toggleSection('projects')
    restarted.toggleSection('chats')
    await flush()
    expect(saved.collapsed_sections).toEqual(['projects'])
  })

  it('4 · a state saved before the field existed shows every section', async () => {
    const { collapsed_sections: _dropped, ...old } = defaultSidebarState
    core.mockImplementation(async () => ({ ...old, collapsed_project_ids: [] }))
    const state = layout()
    await state.load()
    for (const key of ['pinned', 'projects', 'chats'] as const)
      expect(state.isSectionCollapsed(key)).toBe(false)
  })

  it('writes nothing before the saved layout was read', async () => {
    const state = layout()
    state.toggleSection('chats')
    await flush()
    expect(state.isSectionCollapsed('chats')).toBe(false)
    expect(core).not.toHaveBeenCalledWith('sidebar.patch', expect.anything())
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('侧栏'))
  })
})
