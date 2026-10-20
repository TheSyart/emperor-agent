// @vitest-environment jsdom
/**
 * RF-02: the rich composer's skill chips — when the lists open, how chips
 * are made (list, + menu, typing, paste), what a send carries, and the keys
 * that must not send.
 */
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Slice } from 'prosemirror-model'
import type { SlashPaletteItem } from '../../commands'
import type { ChatSendPayload } from '../../types'
import Composer from './ComposerCard.vue'
import {
  composerView,
  pressKey,
  typeInto,
  visibleText,
} from './editor/editorTesting'

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

function skill(name: string, title: string): SlashPaletteItem {
  return {
    id: `command:skill.user.${name}`,
    commandId: `skill.user.${name}`,
    kind: 'skill',
    name: `/${name}`,
    title,
    completion: `/${name}`,
    description: `${title} skill`,
    category: 'Skills',
    source: 'user_skill',
    sourceLabel: 'Personal',
    available: true,
    skillName: name,
  }
}

function command(name: string): SlashPaletteItem {
  return {
    id: `command:builtin.${name}`,
    commandId: `builtin.${name}`,
    kind: 'command',
    name: `/${name}`,
    title: name,
    completion: `/${name}`,
    description: `${name} command`,
    category: 'Commands',
    source: 'builtin',
    sourceLabel: '',
    available: true,
  }
}

function mount(props: Record<string, unknown> = {}) {
  const onSend = vi.fn<(payload: ChatSendPayload) => void>()
  const onError = vi.fn()
  const onStartGoal = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(Composer, {
    busy: false,
    commands: [
      command('model'),
      skill('image-gen', 'Image Gen'),
      skill('skill-creator', 'Skill Creator'),
    ],
    tools: [],
    contextUsed: 0,
    contextMax: 0,
    modelEntries: [],
    providerOptions: [],
    onSend,
    onError,
    onStartGoal,
    ...props,
  })
  app.mount(container)
  return { root: container, onSend, onError, onStartGoal }
}

function paletteLabels(root: HTMLElement): string[] {
  return [
    ...root.querySelectorAll<HTMLElement>('.capability-picker-item strong'),
  ].map((node) => node.textContent ?? '')
}

function pick(root: HTMLElement, label: string): void {
  const button = [
    ...root.querySelectorAll<HTMLButtonElement>('.capability-picker-item'),
  ].find((item) => item.querySelector('strong')?.textContent === label)
  if (!button) throw new Error(`no palette item ${label}`)
  button.click()
}

describe('rich composer references', () => {
  it('lists only skills for / in the middle of a message and puts a chip in place of the typed name', async () => {
    const { root, onSend } = mount()
    const view = composerView(root)
    typeInto(view, '请用 /ima')
    await nextTick()
    expect(paletteLabels(root)).toEqual(['Image Gen'])
    expect(
      root.querySelector('.capability-picker')?.getAttribute('data-mode'),
    ).toBe('mention')
    pick(root, 'Image Gen')
    await nextTick()
    typeInto(view, '画一只猫')
    expect(visibleText(view)).toBe('请用 Image Gen 画一只猫')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend).toHaveBeenCalledWith({
      content: '请用 /image-gen 画一只猫',
      displayContent: '请用 /image-gen 画一只猫',
      attachments: [],
      requestedSkills: [{ name: 'image-gen', source: 'slash' }],
      references: [
        {
          kind: 'skill',
          id: 'image-gen',
          label: 'Image Gen',
          start: 3,
          end: 13,
        },
      ],
    })
    expect(visibleText(view)).toBe('')
  })

  it('keeps commands and skills together only at the start of the message', async () => {
    const { root } = mount()
    const view = composerView(root)
    typeInto(view, '/')
    await nextTick()
    expect(paletteLabels(root)).toEqual(
      expect.arrayContaining(['model', 'Image Gen', 'Skill Creator']),
    )
    pick(root, 'Skill Creator')
    await nextTick()
    expect(root.querySelector('.composer-chip')?.textContent).toBe(
      'Skill Creator',
    )
    expect(visibleText(view)).toBe('Skill Creator ')
  })

  it('opens no list for a slash or @ inside a word, a URL or an address', async () => {
    const { root } = mount()
    const view = composerView(root)
    for (const text of ['a/b', ' https://x.test/p', ' x@y.com']) {
      typeInto(view, text)
      await nextTick()
      expect(root.querySelector('.capability-picker'), text).toBeNull()
    }
  })

  it('hides the list on Escape and shows it again when the name grows', async () => {
    const { root } = mount()
    const view = composerView(root)
    typeInto(view, '看 /i')
    await nextTick()
    expect(root.querySelector('.capability-picker')).not.toBeNull()
    pressKey(view, 'Escape')
    await nextTick()
    expect(root.querySelector('.capability-picker')).toBeNull()
    typeInto(view, 'm')
    await nextTick()
    expect(paletteLabels(root)).toEqual(['Image Gen'])
    // A space ends the name: the list closes and nothing is inserted.
    typeInto(view, ' ')
    await nextTick()
    expect(root.querySelector('.capability-picker')).toBeNull()
    expect(root.querySelector('.composer-chip')).toBeNull()
  })

  it('turns a complete known name into a chip when a space follows, not unknown ones', async () => {
    const { root, onSend } = mount()
    const view = composerView(root)
    typeInto(view, '先 /image-gen 再 /imagegen 结束')
    await nextTick()
    const chips = [...root.querySelectorAll('.composer-chip')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Image Gen'])
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend.mock.calls[0]![0].references).toEqual([
      { kind: 'skill', id: 'image-gen', label: 'Image Gen', start: 2, end: 12 },
    ])
  })

  it('makes a chip of a known name typed right before sending', async () => {
    const { onSend, root } = mount()
    const view = composerView(root)
    typeInto(view, '  用 /skill-creator')
    await nextTick()
    // Enter would pick from the open list; with it closed, Enter sends.
    pressKey(view, 'Escape')
    await nextTick()
    pressKey(view, 'Enter')
    await nextTick()
    // Offsets follow the trimmed text the model receives.
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      content: '用 /skill-creator',
      references: [
        {
          kind: 'skill',
          id: 'skill-creator',
          label: 'Skill Creator',
          start: 2,
          end: 16,
        },
      ],
    })
  })

  it('never sends on an input method Enter; Shift+Enter starts a line', async () => {
    const { root, onSend } = mount()
    const view = composerView(root)
    typeInto(view, '你')
    // While a candidate is being composed, Enter confirms it.
    view.dom.dispatchEvent(
      new CompositionEvent('compositionstart', { data: '' }),
    )
    pressKey(view, 'Enter', { isComposing: true, keyCode: 229 })
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
    // Belt and braces: a composing Enter that reaches the keys is ignored.
    pressKey(view, 'Enter', { keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    pressKey(view, 'Enter', { shiftKey: true })
    typeInto(view, '好')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend.mock.calls[0]![0].content).toBe('你\n好')
  })

  it('inserts skill chips from the + menu and offers no MCP markers there', async () => {
    const { root, onSend } = mount({
      tools: [
        { name: 'search', source: 'mcp', server: 'aihot', description: '' },
      ],
    })
    const view = composerView(root)
    typeInto(view, '整理')
    root
      .querySelector<HTMLButtonElement>('button[aria-label="添加附件与能力"]')!
      .click()
    await nextTick()
    // The + menu's 插入 Skill opens the add palette.
    const insert = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('插入 Skill'))
    expect(insert?.textContent).not.toContain('MCP')
    insert!.click()
    await nextTick()
    expect(
      [...root.querySelectorAll('.composer-palette-label')].map(
        (label) => label.textContent,
      ),
    ).not.toContain('MCP')
    pick(root, 'Image Gen')
    await nextTick()
    expect(visibleText(view)).toBe('整理 Image Gen ')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      content: '整理 /image-gen',
      references: [{ id: 'image-gen', start: 3, end: 13 }],
    })
  })

  it('pastes known names as chips and copies chips as their names', async () => {
    const { root } = mount()
    const view = composerView(root)
    const text = '/skill-creator 和 /unknown\n再 /image-gen'
    view.someProp('handlePaste', (handle) =>
      handle(
        view,
        {
          clipboardData: { files: [], getData: () => text },
        } as unknown as ClipboardEvent,
        Slice.empty,
      ),
    )
    await nextTick()
    expect(
      [...root.querySelectorAll('.composer-chip')].map(
        (chip) => chip.textContent,
      ),
    ).toEqual(['Skill Creator', 'Image Gen'])
    const copied = view.someProp('clipboardTextSerializer', (serialize) =>
      serialize(view.state.doc.slice(0, view.state.doc.content.size), view),
    )
    expect(copied).toBe(text)
  })

  it('keeps chips out of a Goal outcome', async () => {
    const { root, onError, onStartGoal } = mount({ goalCaptureStatus: 'armed' })
    const view = composerView(root)
    typeInto(view, '持续用 /image-gen ')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onStartGoal).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Goal Outcome 暂仅支持纯文字；请先移除附件或 Skill 引用。',
    )
  })
})
