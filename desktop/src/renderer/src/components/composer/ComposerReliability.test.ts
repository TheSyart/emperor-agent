// @vitest-environment jsdom
// FIX-02 (PLAN-V020, findings UI-2/UI-16/UI-17/UI-18, DSH-24): the composer
// never loses a draft. A refused send puts text, chips and attachments back;
// a send waits for uploads; pasted images become attachments; a /word that
// is no command is announced and sent as text; a pasted key asks first.
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef, ChatSendPayload } from '../../types'
import type { SlashPaletteItem } from '../../commands'
import { SECRET_MASK } from '../chat/secretScan'
import Composer from './ComposerCard.vue'
import {
  composerView,
  pressKey,
  typeInto,
  visibleText,
} from './editor/editorTesting'

const uploads: Array<{ file: File; resolve: (ref: AttachmentRef) => void }> = []
vi.mock('../../api/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/attachments')>()),
  uploadAttachment: (file: File) =>
    new Promise<AttachmentRef>((resolve) => uploads.push({ file, resolve })),
}))

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
  uploads.length = 0
})

const attachment = (id: string, name = `${id}.png`): AttachmentRef =>
  ({
    id,
    name,
    mime: 'image/png',
    size: 10,
    kind: 'image',
    hasText: false,
    hasImage: true,
    path: `attachments/${name}`,
  }) as AttachmentRef

const compact: SlashPaletteItem = {
  id: 'command:builtin.compact',
  kind: 'command',
  name: '/compact',
  commandId: 'builtin.compact',
  title: '/compact',
  description: '压缩上下文',
  completion: '/compact',
} as SlashPaletteItem

type Handle = {
  restoreDraft: (payload: Partial<ChatSendPayload>) => void
  setDraft: (text: string) => void
  takeSnapshot: () => { text: string; attachments: AttachmentRef[] }
  applySnapshot: (
    draft: {
      text: string
      references: never[]
      attachments: AttachmentRef[]
    } | null,
  ) => void
}

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  const component = createApp(Composer, {
    busy: false,
    commands: [compact],
    tools: [],
    contextUsed: 0,
    contextMax: 0,
    modelEntries: [],
    providerOptions: [],
    ...props,
  }).mount(container) as unknown as Handle
  return { component, view: composerView(container) }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

describe('composer reliability', () => {
  it('puts text and attachments back when the send is refused', async () => {
    const onSend = vi.fn(async () => false)
    const { component, view } = mount({ onSend })
    component.restoreDraft({ content: '', attachments: [attachment('a1')] })
    await nextTick()
    typeInto(view, '分析这张图')
    await nextTick()
    pressKey(view, 'Enter')
    await flush()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(visibleText(view)).toBe('分析这张图')
    expect(attachmentCount()).toBe(1)
  })

  it('clears the composer once the send is accepted', async () => {
    const onSend = vi.fn(async () => true)
    const { view } = mount({ onSend })
    typeInto(view, 'hello')
    await nextTick()
    pressKey(view, 'Enter')
    await flush()
    expect(visibleText(view)).toBe('')
  })

  it('keeps what was typed meanwhile and adds the refused message after it', async () => {
    let refuse!: (accepted: boolean) => void
    const onSend = vi.fn(
      () => new Promise<boolean>((resolve) => (refuse = resolve)),
    )
    const { view } = mount({ onSend })
    typeInto(view, 'first')
    await nextTick()
    pressKey(view, 'Enter')
    await flush()
    expect(visibleText(view)).toBe('')
    typeInto(view, 'second')
    await nextTick()
    refuse(false)
    await flush()
    expect(paragraphs(view)).toBe('second\n\nfirst')
  })

  it('waits for uploads before sending, then sends the attachment with the message', async () => {
    const onSend = vi.fn(async () => true)
    const onError = vi.fn()
    const { view } = mount({ onSend, onError })
    pasteFiles(view.dom, [new File(['png'], 'shot.png', { type: 'image/png' })])
    await flush()
    expect(uploads).toHaveLength(1)
    typeInto(view, 'look')
    await nextTick()
    const send = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="发送"]',
    )
    expect(send?.disabled).toBe(true)
    pressKey(view, 'Enter')
    await flush()
    expect(onSend).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('附件还在上传，上传完成后再发送。')
    uploads[0]!.resolve(attachment('shot', 'shot.png'))
    await flush()
    pressKey(view, 'Enter')
    await flush()
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'look',
        attachments: [expect.objectContaining({ id: 'shot' })],
      }),
    )
  })

  it('turns a pasted screenshot into an attachment, not text', async () => {
    const { view } = mount()
    pasteFiles(view.dom, [
      new File(['png'], 'Screenshot.png', { type: 'image/png' }),
    ])
    await flush()
    expect(uploads.map((u) => u.file.name)).toEqual(['Screenshot.png'])
    expect(visibleText(view)).toBe('')
  })

  it('says an unknown /word will go out as a message, and sends it', async () => {
    const onSend = vi.fn(async () => true)
    const { view } = mount({ onSend })
    typeInto(view, '/tmp 下有什么')
    await nextTick()
    expect(container!.textContent).toContain(
      '/tmp 不是命令，将作为普通消息发送',
    )
    pressKey(view, 'Enter')
    await flush()
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: '/tmp 下有什么' }),
    )
  })

  it('asks before sending a message that looks like it holds a key', async () => {
    const onSend = vi.fn(async (_payload: ChatSendPayload) => true)
    const key = 'sk-' + 'A1b2C3d4'.repeat(5)
    const { view } = mount({ onSend })
    typeInto(view, `my key is ${key}`)
    await nextTick()
    pressKey(view, 'Enter')
    await flush()
    expect(onSend).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('消息里可能包含密钥')
    button('遮掩后发送').click()
    await flush()
    expect(onSend).toHaveBeenCalledTimes(1)
    const sent = onSend.mock.calls[0]![0]
    expect(sent.content).toBe(`my key is ${SECRET_MASK}`)
    expect(JSON.stringify(sent)).not.toContain(key)
  })

  it('sends the key unchanged when the user insists', async () => {
    const onSend = vi.fn(async () => true)
    const key = 'sk-' + 'Z9'.repeat(15)
    const { view } = mount({ onSend })
    typeInto(view, key)
    await nextTick()
    pressKey(view, 'Enter')
    await flush()
    button('仍然发送').click()
    await flush()
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: key }),
    )
  })

  it('adds an edited message after the current draft instead of replacing it', async () => {
    const { component, view } = mount()
    typeInto(view, 'half written')
    await nextTick()
    component.setDraft('queued message')
    await nextTick()
    expect(paragraphs(view)).toBe('half written\n\nqueued message')
  })

  it('hands its draft over and takes another (one draft per session)', async () => {
    const { component, view } = mount()
    component.restoreDraft({ content: 'for A', attachments: [attachment('x')] })
    await nextTick()
    const saved = component.takeSnapshot()
    expect(saved).toMatchObject({ text: 'for A', attachments: [{ id: 'x' }] })
    component.applySnapshot(null)
    await nextTick()
    expect(visibleText(view)).toBe('')
    expect(attachmentCount()).toBe(0)
    component.applySnapshot({ ...saved, references: [] })
    await nextTick()
    expect(visibleText(view)).toBe('for A')
    expect(attachmentCount()).toBe(1)
  })
})

/** Attachment chips waiting in the tray (images show no file name). */
function attachmentCount(): number {
  const tray = container!.querySelector('.composer-attachments-tray')
  return tray ? tray.querySelectorAll(':scope > :not(.uploading)').length : 0
}

/** The draft with its line breaks (visibleText joins paragraphs). */
function paragraphs(view: ReturnType<typeof composerView>): string {
  const doc = view.state.doc
  return doc.textBetween(0, doc.content.size, '\n')
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function pasteFiles(target: HTMLElement, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      types: ['Files'],
      getData: () => '',
    },
  })
  target.dispatchEvent(event)
}
