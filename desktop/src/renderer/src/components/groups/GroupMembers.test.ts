// @vitest-environment jsdom
/**
 * GRP-08 (预览 B 第 3 步): the members column — one row per member with
 * its status (空闲, 发言中, 执行中, 排队, 等你回答, 出错) following the live
 * events; a status change is read out politely (the status only, never
 * what was said); more than 8 members scroll; 邀请 adds a contact.
 */
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@emperor/core/api'
import type { GroupMemberView, MemberLiveStatus } from './groupModel'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

const { default: GroupMembers } = await import('./GroupMembers.vue')

function member(
  id: string,
  name: string,
  extra: Partial<GroupMemberView> = {},
) {
  return {
    id,
    name,
    intro: '',
    external: false,
    speak: 'relevant' as const,
    memberSessionId: `member-${id}`,
    missing: false,
    ...extra,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const invite = vi.fn()

const state = reactive({
  members: [
    member('ct-emperor', 'Emperor'),
    member('ct-arch', '架构师'),
    member('ct-wri', '写作者'),
    member('ct-cc', 'Claude Code', { external: true, speak: 'mentioned' }),
  ] as GroupMemberView[],
  statuses: {} as Record<string, MemberLiveStatus>,
  tools: {} as Record<string, boolean>,
  pending: {} as Record<
    string,
    { id: string; kind: string; status: string } | null
  >,
  tasks: [] as string[],
  taskList: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  addable: [] as Contact[],
})

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(GroupMembers, {
      ...state,
      contacts: [],
      moderator: 'ct-emperor',
      onInvite: invite,
    }),
  )
  app.mount(container)
  await flush()
}

function status(id: string): string {
  return (
    document
      .querySelector(`[data-member-row="${id}"] [data-status]`)
      ?.textContent?.trim() ?? ''
  )
}

afterEach(() => {
  app?.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
})

describe('the members column', () => {
  it('follows each member’s status and reads the change out politely', async () => {
    await mount()
    expect(document.querySelector('[data-member-count]')?.textContent).toBe(
      '成员 4',
    )
    expect(status('ct-emperor')).toBe('主持人 · 空闲')
    expect(status('ct-cc')).toBe('外部 · 只读 · 只在被 @ 时')
    const announcer = document.querySelector<HTMLElement>(
      '[aria-live="polite"]',
    )!
    expect(announcer.textContent?.trim()).toBe('')

    state.statuses = { 'ct-arch': 'thinking' }
    state.statuses = { ...state.statuses, 'ct-wri': 'queued' }
    state.tasks = ['ct-wri']
    await flush()
    expect(status('ct-arch')).toBe('发言中')
    expect(status('ct-wri')).toBe('排队 · 交办任务')
    expect(announcer.textContent).toContain('架构师 发言中')

    state.tools = { 'ct-arch': true }
    await flush()
    expect(status('ct-arch')).toBe('执行中')

    state.pending = {
      'ct-arch': { id: 'ask_1', kind: 'ask', status: 'waiting' },
    }
    await flush()
    expect(status('ct-arch')).toBe('等你回答')
    expect(announcer.textContent).toContain('架构师 等你回答')

    state.pending = {}
    state.tools = {}
    state.statuses = { 'ct-arch': 'error' }
    await flush()
    expect(status('ct-arch')).toBe('出错')
  })

  it('scrolls past 8 members', async () => {
    state.members = Array.from({ length: 10 }, (_, i) =>
      member(`ct-${i}`, `成员${i}`),
    )
    await mount()
    const list = document.querySelector<HTMLElement>('[data-member-list]')!
    expect(list.querySelectorAll('[data-member-row]')).toHaveLength(10)
    expect(list.dataset.scroll).toBe('true')
  })

  it('invites a contact who is not in the group', async () => {
    state.members = [member('ct-emperor', 'Emperor')]
    state.addable = [
      {
        id: 'ct-res',
        kind: 'local',
        name: '研究员',
        avatar: { kind: 'library', id: 'AV-04-1' },
        intro: '资料调研',
        domains: ['content'],
        role: {
          mission: '',
          deliverable: '',
          playbook: '',
          boundaries: '',
          knowledge: [],
        },
        capabilities: {
          model: 'inherit',
          tools: { preset: 'read_only' },
          permission: 'read_only',
        },
        groupHabit: { speak: 'relevant', length: 'brief' },
        memory: { enabled: true },
        version: 1,
        builtin: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    await mount()
    document.querySelector<HTMLElement>('[data-invite]')!.click()
    await flush()
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ].find((element) => element.textContent?.includes('研究员'))!
    item.click()
    expect(invite).toHaveBeenCalledWith('ct-res')
  })

  it('CG-05: puts task and independent progress here, and opens only this group member session', async () => {
    core.mockReset().mockResolvedValue({ events: [], more: false })
    state.members = [
      member('ct-emperor', 'Emperor'),
      member('ct-arch', '架构师'),
      member('ct-wri', '写作者'),
    ]
    state.taskList = [
      {
        taskId: 'gt-1',
        to: 'ct-arch',
        title: '整理公开报告',
        deliverable: '报告',
        access: 'group_files',
        state: 'running',
        attempt: 1,
      },
    ]
    state.messages = [
      {
        id: 'q1',
        turnId: 't1',
        from: 'user',
        audience: { kind: 'all' },
        ask: ['ct-arch', 'ct-wri'],
        answerMode: 'independent',
        batchId: 'b1',
        kind: 'say',
        text: '分别回答',
        at: 1,
        private: false,
        hidden: false,
      },
      {
        id: 'a1',
        turnId: 't1',
        from: 'ct-arch',
        audience: { kind: 'all' },
        ask: [],
        answerMode: 'independent',
        batchId: 'b1',
        kind: 'say',
        text: '未揭晓的秘密答案',
        at: 2,
        private: false,
        hidden: true,
      },
    ]
    await mount()
    expect(
      document.querySelector('[data-task-progress]')?.textContent,
    ).toContain('整理公开报告')
    expect(
      document.querySelector('[data-task-progress]')?.textContent,
    ).toContain('进行中')
    expect(
      document.querySelector('[data-independent-progress]')?.textContent,
    ).toContain('1/2')
    expect(
      document.querySelector('[data-independent-progress]')?.textContent,
    ).not.toContain('未揭晓的秘密答案')
    expect(document.querySelector('[data-task-progress] button')).toBeNull()
    document.querySelector<HTMLElement>('[data-member-row="ct-arch"]')!.click()
    await flush()
    expect(
      document
        .querySelector('[data-member-activity]')
        ?.getAttribute('data-session-id'),
    ).toBe('member-ct-arch')
    expect(core).toHaveBeenCalledWith('sessions.history', {
      sessionId: 'member-ct-arch',
      maxMessages: 50,
    })
  })

  it('CG-05: does not leave a member without a group session loading forever', async () => {
    core.mockReset()
    state.members = [
      member('ct-gone', '已删除的联系人', {
        memberSessionId: null,
        missing: true,
      }),
    ]
    await mount()
    document.querySelector<HTMLElement>('[data-member-row="ct-gone"]')!.click()
    await flush()
    const activity = document.querySelector('[data-member-activity]')!
    expect(activity.textContent).not.toContain('读取执行记录')
    expect(activity.textContent).toContain('本群会话还没有工具记录')
    expect(core).not.toHaveBeenCalledWith('sessions.history', expect.anything())
  })
})
