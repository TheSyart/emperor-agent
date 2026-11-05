// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactRoleDraftMeta } from '@emperor/core/api'
import type { ToolChatNode } from '../../conversation/types'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
vi.mock('./TrialBench.vue', () => ({
  default: {
    props: ['draft'],
    setup(props: Readonly<{ draft: { name: string } }>) {
      return () => h('div', { 'data-stub-trial': '' }, props.draft.name)
    },
  },
}))
const { default: RoleDraftCard } = await import('./RoleDraftCard.vue')

const draft = {
  name: '证据研究员',
  avatar: { kind: 'library', id: 'AV-05-1' },
  intro: '查找并核验资料',
  domains: ['data'],
  role: {
    mission: '查找可靠资料。',
    deliverable: '带引用的结论。',
    playbook: '先检索，再交叉核验。',
    boundaries: '不编造来源。',
  },
  knowledge: [],
  skills: [{ id: 'sk-review', sourceId: 'user', name: 'review' }],
  mcp: [{ serverId: 'docs', toolNames: ['search', 'read'] }],
  capabilities: {
    model: 'inherit',
    tools: { preset: 'read_only', allow: [] },
    permission: 'read_only',
  },
  groupHabit: { speak: 'mentioned', length: 'brief' },
  memory: { enabled: true },
} as const

function meta(extra: Partial<ContactRoleDraftMeta> = {}): ContactRoleDraftMeta {
  return {
    kind: 'contact-role-draft',
    action: 'create',
    draft: JSON.parse(JSON.stringify(draft)),
    ...extra,
  }
}

function node(value: ContactRoleDraftMeta): ToolChatNode {
  return {
    key: 'tool:draft-1',
    kind: 'tool',
    turn: 1,
    step: 1,
    data: {
      callId: 'draft-1',
      name: 'contact_role_draft',
      argsRaw: '{}',
      turn: 1,
      step: 1,
      time: 1,
      status: 'settled',
      approvals: [],
      result: {
        seq: 4,
        time: 2,
        content: [],
        isError: false,
        meta: value,
      },
    },
  } as unknown as ToolChatNode
}

let app: App | null = null
let container: HTMLDivElement | null = null

async function flush() {
  for (let index = 0; index < 7; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

async function mount(value = meta()) {
  container = document.createElement('div')
  document.body.append(container)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => '' } },
      {
        path: '/contacts/:id',
        name: 'contact',
        component: { render: () => '' },
      },
    ],
  })
  app = createApp(() => h(RoleDraftCard, { node: node(value) }))
  app.use(router)
  app.mount(container)
  await flush()
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent?.trim() === label)
  if (!found) throw new Error(`missing ${label}`)
  return found
}

beforeEach(() => {
  core.mockReset()
  core.mockImplementation(async (op: string) => {
    if (op === 'contacts.list') return { contacts: [], readOnly: null }
    if (op === 'contacts.create')
      return { ...draft, id: 'ct-saved', version: 1 }
    if (op === 'contacts.update')
      return { ...draft, id: 'ct-target', version: 2 }
    throw new Error(op)
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('RoleDraftCard', () => {
  it('keeps the draft unsaved until confirmation and hands adjustments to the composer', async () => {
    await mount()
    expect(
      document.querySelector('[data-role-draft-card]')?.textContent,
    ).toContain('草稿尚未保存')
    expect(core).not.toHaveBeenCalledWith('contacts.create', expect.anything())
    const listener = vi.fn()
    window.addEventListener('emperor:set-composer-draft', listener)
    button('继续调整').click()
    expect(listener.mock.calls[0]![0].detail.text).toContain('证据研究员')
    window.removeEventListener('emperor:set-composer-draft', listener)
    button('先试用').click()
    await flush()
    expect(document.querySelector('[data-stub-trial]')?.textContent).toBe(
      '证据研究员',
    )
  })

  it('confirms creation through contacts.create once', async () => {
    await mount()
    button('确认创建').click()
    await flush()
    expect(core).toHaveBeenCalledWith(
      'contacts.create',
      expect.objectContaining({ name: '证据研究员' }),
    )
    expect(
      core.mock.calls.filter(([op]) => op === 'contacts.create'),
    ).toHaveLength(1)
    expect(
      document.querySelector('[data-role-draft-card]')?.textContent,
    ).toContain('已保存')
  })

  it('does not duplicate an already saved draft after reopening', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.list')
        return { contacts: [{ ...draft, id: 'ct-existing' }], readOnly: null }
      throw new Error(op)
    })
    await mount()
    expect(
      document.querySelector('[data-role-draft-card]')?.textContent,
    ).toContain('已保存')
    expect(core).not.toHaveBeenCalledWith('contacts.create', expect.anything())
  })

  it('blocks a same-name different draft instead of silently duplicating it', async () => {
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.list')
        return {
          contacts: [{ ...draft, id: 'ct-existing', intro: '另一个岗位' }],
          readOnly: null,
        }
      throw new Error(op)
    })
    await mount()
    button('确认创建').click()
    await flush()
    expect(core).not.toHaveBeenCalledWith('contacts.create', expect.anything())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '同名',
    )
  })

  it('confirms an edit with only its exact target and patch', async () => {
    await mount(
      meta({
        action: 'edit',
        targetId: 'ct-target',
        patch: { intro: '只改简介' },
      }),
    )
    button('确认调整').click()
    await flush()
    expect(core).toHaveBeenCalledWith('contacts.update', {
      id: 'ct-target',
      patch: { intro: '只改简介' },
    })
  })
})
