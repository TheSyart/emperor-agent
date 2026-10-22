// @vitest-environment jsdom
// UI-S14 · 5 · 6: the subagent status bar above the composer — its head,
// the list it opens upward, 「回到列表 ↑」 and the rows that open a child.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentView } from '@emperor/core/runtime-contract'
import {
  subagentRowOfAgent,
  type SubagentRowView,
} from '../conversation/subagentRows'
import SubagentDock from './SubagentDock.vue'

const T0 = Date.now()

function agent(id: string, patch: Partial<AgentView>): AgentView {
  return {
    id,
    kind: 'internal',
    backend: 'internal',
    rootSessionId: 'root',
    parentAgentId: 'root',
    title: `写 ${id}`,
    phase: 'running',
    createdAt: T0 - 49_000,
    updatedAt: T0 - 49_000,
    ...patch,
  }
}

const ROWS: SubagentRowView[] = [
  subagentRowOfAgent(agent('sub-1', {})),
  subagentRowOfAgent(agent('sub-2', {})),
  subagentRowOfAgent(
    agent('dlg-5', {
      kind: 'external',
      backend: 'codex',
      title: 'codex 写第 5 章',
      phase: 'failed',
      updatedAt: T0 - 35_000,
    }),
  ),
]

let app: App | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount(target: string | null = 'agents:call') {
  const opened: SubagentRowView[] = []
  const revealed: string[] = []
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () =>
      h(SubagentDock, {
        rows: ROWS,
        target,
        rootSessionId: 'root',
        onOpen: (row: SubagentRowView) => opened.push(row),
        onReveal: (id: string) => revealed.push(id),
      }),
  })
  app.mount(host)
  return { root: host, opened, revealed }
}

describe('subagent status bar (UI-S14 · 6)', () => {
  it('heads with the faces, how many run and the other counts', async () => {
    const { root } = mount()
    await settle()
    const toggle = root.querySelector<HTMLElement>(
      '[data-subagent-dock-toggle]',
    )!
    expect(toggle.textContent).toContain('2 个子智能体运行中')
    expect(toggle.textContent).toContain('1 失败')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(root.querySelectorAll('[data-subagent-dock-face]')).toHaveLength(3)
    expect(root.querySelector('[data-subagent-dock-list]')).toBeNull()
  })

  it('opens upward into a list of the same rows, and closes again', async () => {
    const { root } = mount()
    await settle()
    const toggle = root.querySelector<HTMLElement>(
      '[data-subagent-dock-toggle]',
    )!
    toggle.click()
    await settle()
    const list = root.querySelector<HTMLElement>('[data-subagent-dock-list]')!
    expect(list).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(list.querySelectorAll('[data-subagent-row]')).toHaveLength(3)
    // Above the head: the list comes first in the bar.
    expect(
      list.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(list.querySelector('[data-agent-logo="codex"]')).not.toBeNull()
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(root.querySelector('[data-subagent-dock-list]')).toBeNull()
  })

  it('「回到列表 ↑」 asks the conversation to go back to the group', async () => {
    const { root, revealed } = mount('agents:call-sub-1')
    await settle()
    const jump = root.querySelector<HTMLElement>('[data-subagent-dock-jump]')!
    expect(jump.textContent?.trim()).toBe('回到列表 ↑')
    jump.click()
    expect(revealed).toEqual(['agents:call-sub-1'])
    // Going back does not open the list.
    await settle()
    expect(root.querySelector('[data-subagent-dock-list]')).toBeNull()
  })

  it('offers no way back when the group is not loaded', async () => {
    const { root } = mount(null)
    await settle()
    expect(root.querySelector('[data-subagent-dock-jump]')).toBeNull()
  })

  it('a row opens its subagent', async () => {
    const { root, opened } = mount()
    await settle()
    root.querySelector<HTMLElement>('[data-subagent-dock-toggle]')!.click()
    await settle()
    const entries = root.querySelectorAll<HTMLAnchorElement>(
      '[data-subagent-dock-list] [data-agent-entry]',
    )
    expect(entries[0]!.getAttribute('href')).toBe('/chat/sub-1')
    expect(entries[2]!.getAttribute('href')).toBe('/chat/root/agents/dlg-5')
    entries[2]!.click()
    expect(opened.map((row) => row.agentId)).toEqual(['dlg-5'])
  })
})

describe('subagent status bar loading (UI-S14 · 5)', () => {
  it('loads with the conversation, not at start-up', () => {
    const view = readFileSync(
      join(__dirname, '../conversation/ConversationView.vue'),
      'utf8',
    )
    expect(view).toMatch(
      /defineAsyncComponent\(\s*\(\) => import\('\.\.\/composer\/SubagentDock\.vue'\),?\s*\)/,
    )
    expect(view).not.toMatch(/^import SubagentDock/m)
  })
})
