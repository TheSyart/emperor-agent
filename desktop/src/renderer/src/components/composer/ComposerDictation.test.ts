// @vitest-environment jsdom
/**
 * VO-03: dictation in the rich composer — the 听写 button and shortcut,
 * partial results as a draft, the final inserted once where dictation
 * began, cancel, failures, a chat switch, and never a send.
 */
import { TextSelection } from 'prosemirror-state'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationEvent, DictationStatus } from '../../api/dictation'
import type { SlashPaletteItem } from '../../commands'
import type { ChatSendPayload } from '../../types'
import { resetDictationSettingsForTest } from '../../dictation/settings'
import Composer from './ComposerCard.vue'
import { forgetKeptDictationsForTest } from './composerDictation'
import { composerView, typeInto, visibleText } from './editor/editorTesting'

const api = vi.hoisted(() => ({
  supported: true,
  listeners: new Set<(event: DictationEvent) => void>(),
  dictationStatus: vi.fn(),
  startDictation: vi.fn(),
  stopDictation: vi.fn(async () => true),
  cancelDictation: vi.fn(async () => true),
}))

vi.mock('../../api/dictation', () => ({
  dictationSupported: () => api.supported,
  dictationStatus: api.dictationStatus,
  startDictation: api.startDictation,
  stopDictation: api.stopDictation,
  cancelDictation: api.cancelDictation,
  onDictationEvent: (listener: (event: DictationEvent) => void) => {
    api.listeners.add(listener)
    return () => api.listeners.delete(listener)
  },
}))

const ready: DictationStatus = {
  supported: true,
  available: true,
  engine: 'sf-speech',
  permissions: { microphone: 'granted', speech: 'granted' },
  devices: [{ id: 'mic', name: 'Mic', default: true }],
  locales: [{ id: 'zh-CN', name: '中文（中国大陆）' }],
  systemLocale: 'zh-Hans-CN',
  active: false,
}

const SESSION = 'session-0001'
let seq = 0

/** One dictation event without its session and sequence number. */
type Heard = {
  [Type in DictationEvent['type']]: Omit<
    Extract<DictationEvent, { type: Type }>,
    'session' | 'seq'
  >
}[DictationEvent['type']]

function hear(event: Heard): void {
  seq += 1
  const full = { session: SESSION, seq, ...event } as DictationEvent
  for (const listener of [...api.listeners]) listener(full)
}

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

let app: App | null = null
let container: HTMLDivElement | null = null

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  await nextTick()
}

function mount(chat = 'chat-a') {
  const onSend = vi.fn<(payload: ChatSendPayload) => void>()
  const onError = vi.fn<(message: string) => void>()
  const props = reactive({
    busy: false,
    commands: [skill('image-gen', 'Image Gen')],
    plugins: [],
    tools: [],
    contextUsed: 0,
    contextMax: 0,
    modelEntries: [],
    providerOptions: [],
    dictationChat: chat as string | null,
    onSend,
    onError,
  })
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(Composer, props) })
  app.mount(container)
  const root = container
  return {
    root,
    props,
    onSend,
    onError,
    view: () => composerView(root),
    button: (label: string) =>
      root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    draft: () =>
      root.querySelector<HTMLElement>('.composer-dictation-draft')
        ?.textContent ?? null,
  }
}

async function startByButton(composer: ReturnType<typeof mount>) {
  composer.button('听写')!.click()
  await settle()
  hear({ type: 'started', locale: 'zh-CN' })
  await settle()
}

/**
 * Put the caret (or a selection) somewhere, as a click would: the editor
 * has focus, and jsdom's late selection events are over before it moves.
 */
async function placeCaret(
  view: ReturnType<ReturnType<typeof mount>['view']>,
  from: number,
  to = from,
): Promise<void> {
  view.focus()
  await settle()
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  )
  await settle()
  expect([view.state.selection.from, view.state.selection.to]).toEqual([
    from,
    to,
  ])
}

function text(composer: ReturnType<typeof mount>): string {
  return visibleText(composer.view())
}

// jsdom has no layout for ranges; a focused editor scrolls to its caret.
Range.prototype.getClientRects ??= () =>
  [] as unknown as ReturnType<Range['getClientRects']>
Range.prototype.getBoundingClientRect ??= () => new DOMRect()

beforeEach(() => {
  seq = 0
  api.supported = true
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  api.dictationStatus.mockResolvedValue(ready)
  api.startDictation.mockResolvedValue({ ok: true, session: SESSION })
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  api.listeners.clear()
  localStorage.clear()
  resetDictationSettingsForTest()
  forgetKeptDictationsForTest()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('dictation in the composer', () => {
  it('shows a draft while you speak, inserts the final once and never sends', async () => {
    const composer = mount()
    await startByButton(composer)
    expect(api.startDictation).toHaveBeenCalledWith({
      device: null,
      locale: null,
    })
    expect(composer.button('结束听写')).not.toBeNull()
    hear({ type: 'partial', text: '你' })
    hear({ type: 'partial', text: '你好' })
    await settle()
    expect(composer.draft()).toBe('你好')
    expect(text(composer)).toBe('你好')
    expect(composer.view().state.doc.textContent).toBe('')
    hear({ type: 'final', text: '你好。' })
    hear({ type: 'final', text: '你好。' })
    hear({ type: 'ended', reason: 'stopped' })
    await settle()
    expect(composer.view().state.doc.textContent).toBe('你好。')
    expect(composer.draft()).toBeNull()
    expect(composer.button('听写')).not.toBeNull()
    expect(composer.onSend).not.toHaveBeenCalled()
  })

  it('inserts in the middle of a draft and replaces a selection', async () => {
    const composer = mount()
    const view = composer.view()
    typeInto(view, 'hello world')
    await placeCaret(view, 6)
    await startByButton(composer)
    hear({ type: 'final', text: 'big' })
    hear({ type: 'ended', reason: 'stopped' })
    await settle()
    expect(view.state.doc.textContent).toBe('hello big world')

    await placeCaret(view, 11, 16)
    api.startDictation.mockResolvedValue({ ok: true, session: 'session-0002' })
    composer.button('听写')!.click()
    await settle()
    for (const listener of [...api.listeners])
      listener({
        type: 'final',
        session: 'session-0002',
        seq: 1,
        text: 'there',
      })
    await settle()
    expect(view.state.doc.textContent).toBe('hello big there')
  })

  it('leaves chips alone and keeps what you type while speaking', async () => {
    const composer = mount()
    const view = composer.view()
    typeInto(view, '/image-gen 画')
    await startByButton(composer)
    typeInto(view, '一只')
    hear({ type: 'final', text: '猫' })
    await settle()
    expect(visibleText(view)).toBe('Image Gen 画猫一只')
    expect(
      view.dom.querySelectorAll('.composer-chip[data-kind="skill"]'),
    ).toHaveLength(1)
  })

  it('cancels: the draft goes away and nothing is inserted', async () => {
    const composer = mount()
    await startByButton(composer)
    hear({ type: 'partial', text: 'noise' })
    await settle()
    composer.button('取消听写')!.click()
    await settle()
    expect(api.cancelDictation).toHaveBeenCalledWith(SESSION)
    expect(composer.draft()).toBeNull()
    hear({ type: 'final', text: 'noise' })
    hear({ type: 'ended', reason: 'cancelled' })
    await settle()
    expect(composer.view().state.doc.textContent).toBe('')
    expect(composer.button('听写')).not.toBeNull()
  })

  it('says where to look when permission is denied', async () => {
    api.startDictation.mockResolvedValue({
      ok: false,
      code: 'permission_denied',
      message: '没有麦克风权限',
    })
    const composer = mount()
    composer.button('听写')!.click()
    await settle()
    expect(composer.onError).toHaveBeenCalledWith(
      expect.stringContaining('设置 › 语音'),
    )
    expect(composer.button('听写')).not.toBeNull()
  })

  it('reports a recognition failure and inserts nothing', async () => {
    const composer = mount()
    await startByButton(composer)
    hear({ type: 'partial', text: '半句' })
    hear({
      type: 'error',
      code: 'recognizer_unavailable',
      message: '本机识别模型不可用',
    })
    hear({ type: 'ended', reason: 'error' })
    await settle()
    expect(composer.onError).toHaveBeenCalledWith(
      expect.stringContaining('本机识别模型不可用'),
    )
    expect(composer.draft()).toBeNull()
    expect(composer.view().state.doc.textContent).toBe('')
  })

  it('stops on a chat switch and offers the result only in its own chat', async () => {
    const composer = mount('chat-a')
    await startByButton(composer)
    hear({ type: 'partial', text: '给 A' })
    await settle()
    composer.props.dictationChat = 'chat-b'
    await settle()
    expect(api.stopDictation).toHaveBeenCalledWith(SESSION)
    expect(composer.draft()).toBeNull()
    hear({ type: 'final', text: '给 A 的话' })
    hear({ type: 'ended', reason: 'stopped' })
    await settle()
    expect(composer.view().state.doc.textContent).toBe('')
    expect(composer.root.textContent).not.toContain('给 A 的话')

    composer.props.dictationChat = 'chat-a'
    await settle()
    expect(composer.root.textContent).toContain('给 A 的话')
    composer.button('插入听写内容')!.click()
    await settle()
    expect(composer.view().state.doc.textContent).toBe('给 A 的话')
    expect(composer.button('插入听写内容')).toBeNull()
  })

  it('starts and stops with the shortcut', async () => {
    const composer = mount()
    const key = () =>
      composer.view().dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'D',
          code: 'KeyD',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    key()
    await settle()
    expect(api.startDictation).toHaveBeenCalledTimes(1)
    hear({ type: 'started', locale: 'zh-CN' })
    await settle()
    key()
    await settle()
    expect(api.stopDictation).toHaveBeenCalledWith(SESSION)
    expect(composer.onSend).not.toHaveBeenCalled()
  })

  it('has no microphone where dictation is not supported', async () => {
    api.supported = false
    const composer = mount()
    await settle()
    expect(composer.button('听写')).toBeNull()
  })
})
