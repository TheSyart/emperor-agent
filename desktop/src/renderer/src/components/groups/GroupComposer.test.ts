// @vitest-environment jsdom
/**
 * GRP-08 (预览 B 第 3 步): the group's composer — 发给 ▾ with the five ways
 * (each one sends its own envelope), the recipient for a private message
 * or a task, the task form, @ completion (↑↓, Enter, Esc), the mention
 * mirror in the box and Enter to send (Shift+Enter is a new line).
 */
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupMemberView } from './groupModel'

const { default: GroupComposer } = await import('./GroupComposer.vue')

function member(
  id: string,
  name: string,
  extra: Partial<GroupMemberView> = {},
) {
  return {
    id,
    name,
    intro: `${name}的简介`,
    external: false,
    speak: 'relevant' as const,
    memberSessionId: `member-${id}`,
    missing: false,
    ...extra,
  }
}

const MEMBERS: GroupMemberView[] = [
  member('ct-emperor', 'Emperor'),
  member('ct-arch', '架构师'),
  member('ct-rev', '审稿人'),
  member('ct-res', '研究员'),
]

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const submit = vi.fn(async (_input: unknown) => true)

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(GroupComposer, {
      members: MEMBERS,
      contacts: [],
      moderator: 'ct-emperor',
      submit,
    }),
  )
  app.mount(container)
  await flush()
}

function area(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(
    '[data-group-composer] textarea',
  )!
}

async function type(text: string) {
  const element = area()
  element.value = text
  element.setSelectionRange(text.length, text.length)
  element.dispatchEvent(new Event('input'))
  await flush()
}

async function key(name: string, extra: KeyboardEventInit = {}) {
  area().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  )
  await flush()
}

async function choose(label: string) {
  document.querySelector<HTMLElement>('[data-audience]')!.click()
  await flush()
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((element) => element.textContent?.includes(label))!
  item.click()
  await flush()
}

function sendButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === '发送',
  )!
}

async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}

beforeEach(() => {
  submit.mockClear()
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  document.body.innerHTML = ''
  app = null
  container = null
})

describe('发给 ▾', () => {
  it('starts on 所有人 · 举手 and lists the five ways with what each does', async () => {
    await mount()
    expect(document.querySelector('[data-audience]')?.textContent).toContain(
      '发给：所有人 · 举手',
    )
    document.querySelector<HTMLElement>('[data-audience]')!.click()
    await flush()
    const items = [
      ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ]
    expect(items.map((item) => item.dataset.way)).toEqual([
      'broadcast',
      'independent',
      'mention',
      'private',
      'task',
    ])
    expect(items[0]!.textContent).toContain('所有人 · 有关的人举手')
    expect(items[1]!.textContent).toContain('每人都答，答完前彼此看不到')
    expect(items[4]!.textContent).toContain('布置一件有交付物的任务')
  })

  it('sends a broadcast, an independent ask and a mention as their envelopes', async () => {
    await mount()
    await type('大家怎么看？')
    sendButton().click()
    await flush()
    await choose('各自独立回答')
    await type('各自说说最担心的一点')
    sendButton().click()
    await flush()
    await choose('@ 指定成员')
    await type('@审稿人 @架构师 接力')
    sendButton().click()
    await flush()
    expect(submit.mock.calls.map(([input]) => input)).toEqual([
      { way: 'broadcast', text: '大家怎么看？' },
      {
        way: 'independent',
        text: '各自说说最担心的一点',
        ask: ['ct-arch', 'ct-rev', 'ct-res'],
      },
      {
        way: 'mention',
        text: '@审稿人 @架构师 接力',
        ask: ['ct-rev', 'ct-arch'],
      },
    ])
  })

  it('sends a private message to the member picked', async () => {
    await mount()
    await choose('私信…')
    await type('私下说一句')
    sendButton().click()
    await flush()
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('[data-composer-hint]')?.textContent).toBe(
      '选一位成员私信',
    )
    document.querySelector<HTMLElement>('[data-recipient="ct-res"]')!.click()
    await flush()
    sendButton().click()
    await flush()
    expect(submit).toHaveBeenCalledWith({
      way: 'private',
      text: '私下说一句',
      to: 'ct-res',
    })
  })

  it('hands out a task with the task form', async () => {
    await mount()
    await choose('交办…')
    expect(document.querySelector('[data-task-form]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-recipient="ct-rev"]')!.click()
    await fill('[data-task-title] input', '写停止规则说明')
    await fill('[data-task-deliverable] input', '一页 Markdown')
    const access = [
      ...document.querySelectorAll<HTMLElement>('[role="radio"]'),
    ].find((radio) => radio.textContent?.includes('只读'))!
    access.click()
    await flush()
    sendButton().click()
    await flush()
    expect(submit).toHaveBeenCalledWith({
      way: 'task',
      text: '写停止规则说明',
      to: 'ct-rev',
      task: {
        title: '写停止规则说明',
        deliverable: '一页 Markdown',
        access: 'readonly',
      },
    })
    // A task sent, the composer goes back to 所有人 · 举手.
    expect(document.querySelector('[data-task-form]')).toBeNull()
    expect(document.querySelector('[data-audience]')?.textContent).toContain(
      '所有人 · 举手',
    )
  })
})

describe('@ completion and keys', () => {
  it('completes a member’s name with ↑↓ and Enter, and Esc closes the list', async () => {
    await mount()
    await type('请 @')
    const options = () => [
      ...document.querySelectorAll<HTMLElement>(
        '[data-mention-list] [role="option"]',
      ),
    ]
    expect(options().map((option) => option.dataset.member)).toEqual([
      'ct-emperor',
      'ct-arch',
      'ct-rev',
      'ct-res',
    ])
    await key('ArrowDown')
    await key('ArrowDown')
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')
    await key('Enter')
    expect(area().value).toBe('请 @审稿人 ')
    expect(submit).not.toHaveBeenCalled()
    await type('请 @审稿人 再 @研')
    expect(options().map((option) => option.dataset.member)).toEqual(['ct-res'])
    await key('Escape')
    expect(document.querySelector('[data-mention-list]')).toBeNull()
  })

  it('sends with Enter; Shift+Enter and an input method Enter do not', async () => {
    await mount()
    await type('第一行')
    await key('Enter', { shiftKey: true })
    expect(submit).not.toHaveBeenCalled()
    await key('Enter', { isComposing: true })
    expect(submit).not.toHaveBeenCalled()
    await key('Enter')
    expect(submit).toHaveBeenCalledWith({ way: 'broadcast', text: '第一行' })
    expect(area().value).toBe('')
  })

  it('still sends with ⌘↵', async () => {
    await mount()
    await type('第二行')
    await key('Enter', { metaKey: true })
    expect(submit).toHaveBeenCalledWith({ way: 'broadcast', text: '第二行' })
  })

  it('paints a picked name in the box, and leaves e-mail alone', async () => {
    await mount()
    await type('请 @研究员 看看')
    expect(document.querySelector('[data-composer-mention]')?.textContent).toBe(
      '@研究员',
    )
    await type('a@b.com')
    expect(document.querySelector('[data-composer-mention]')).toBeNull()
  })

  it('shows the draft itself while an input method composes', async () => {
    await mount()
    const field = () => document.querySelector('[data-group-composer] .field')
    area().dispatchEvent(new CompositionEvent('compositionstart'))
    await flush()
    expect(field()?.getAttribute('data-composing')).toBe('true')
    area().dispatchEvent(new CompositionEvent('compositionend'))
    await flush()
    expect(field()?.getAttribute('data-composing')).toBeNull()
  })

  it('keeps the mirror scrolled with the box', async () => {
    await mount()
    await type('第一行\n第二行\n第三行')
    area().scrollTop = 18
    area().dispatchEvent(new Event('scroll'))
    await flush()
    expect(
      document.querySelector<HTMLElement>('[data-group-composer] .mirror')!
        .scrollTop,
    ).toBe(18)
  })

  it('stops a mention without an @ and says why', async () => {
    await mount()
    await choose('@ 指定成员')
    await type('看看')
    await key('Enter', { metaKey: true })
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('[data-composer-hint]')?.textContent).toBe(
      '先 @ 一位成员：输入 @ 就能选人',
    )
  })
})
