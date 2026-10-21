// @vitest-environment jsdom
/**
 * UI-S04 (reduced by the user on 2026-10-20: Codex is a reference for
 * visual quality only; Emperor keeps its own layout): the bottom bar keeps
 * + (attachments, Skills and plugins, a screenshot, Plan 模式, Goal 模式),
 * the permission chip (presets only) with the Plan capsule beside it, the
 * model chip with 添加模型…, the context ring, and the send slot — which is
 * the microphone while the composer is empty.
 */
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationStatus } from '../../api/dictation'
import type {
  AttachmentRef,
  ControlPayload,
  CurrentModelConfig,
  ModelEntry,
} from '../../types'
import { resetDictationSettingsForTest } from '../../dictation/settings'
import Composer from './ComposerCard.vue'
import { forgetKeptDictationsForTest } from './composerDictation'
import { composerView, typeInto } from './editor/editorTesting'

const api = vi.hoisted(() => ({
  dictation: true,
  screenshot: true,
  capture: vi.fn<() => Promise<File | null>>(),
  uploads: [] as File[],
}))

vi.mock('../../api/dictation', () => ({
  dictationSupported: () => api.dictation,
  dictationStatus: vi.fn(async (): Promise<DictationStatus> => ({
    supported: true,
    available: true,
    engine: 'sf-speech',
    permissions: { microphone: 'granted', speech: 'granted' },
    devices: [],
    locales: [],
    systemLocale: 'zh-Hans-CN',
    active: false,
  })),
  startDictation: vi.fn(async () => ({ ok: true, session: 'session-1' })),
  stopDictation: vi.fn(async () => true),
  cancelDictation: vi.fn(async () => true),
  onDictationEvent: () => () => undefined,
}))

vi.mock('../../api/screenshot', () => ({
  screenshotSupported: () => api.screenshot,
  captureScreenshot: () => api.capture(),
}))

vi.mock('../../api/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/attachments')>()),
  uploadAttachment: async (file: File): Promise<AttachmentRef> => {
    api.uploads.push(file)
    return {
      id: `att-${api.uploads.length}`,
      name: file.name,
      mime: file.type,
      size: file.size,
      kind: 'image',
      hasText: false,
      hasImage: true,
      path: `attachments/${file.name}`,
    } as AttachmentRef
  },
}))

const entries = [
  {
    entryId: 'main',
    provider: 'anthropic',
    protocol: 'anthropic',
    modelId: 'claude-sonnet',
    effectiveDisplayName: 'Claude Sonnet',
    reasoningEffort: 'high',
    contextWindowTokens: 128_000,
  },
  {
    entryId: 'alt',
    provider: 'deepseek',
    protocol: 'openai',
    modelId: 'deepseek-flash',
    effectiveDisplayName: 'DeepSeek Flash',
    reasoningEffort: null,
    contextWindowTokens: 1_000_000,
  },
] as unknown as ModelEntry[]

const currentModel = {
  entryId: 'main',
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  protocol: 'anthropic',
  modelId: 'claude-sonnet',
  effectiveDisplayName: 'Claude Sonnet',
  reasoningEffort: 'high',
  reasoningEfforts: ['low', 'medium', 'high'],
  contextWindowTokens: 128_000,
} as unknown as CurrentModelConfig

const control = {
  preset: 'workspace-write',
  mode: 'workspace-write',
  plan: false,
} as unknown as ControlPayload

let app: App | null = null
let host: HTMLDivElement | null = null

function mount(overrides: Record<string, unknown> = {}) {
  const props = reactive<Record<string, unknown>>({
    busy: false,
    commands: [],
    plugins: [],
    contextUsed: 12_000,
    contextMax: 128_000,
    control,
    currentModel,
    modelEntries: entries,
    providerOptions: [],
    lifecycleMode: null,
    dictationChat: 'chat-a',
    onSend: vi.fn(() => true),
    onStop: vi.fn(),
    onError: vi.fn(),
    onActivatePlan: vi.fn(),
    onActivateGoal: vi.fn(),
    onDismissLifecycle: vi.fn(),
    ...overrides,
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(Composer, props) })
  app.mount(host)
  return { root: host, props }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function bottomBar(root: HTMLElement): HTMLElement {
  const bar = root.querySelector<HTMLElement>('.composer-bar')
  if (!bar) throw new Error('no composer bottom bar')
  return bar
}

/** The bar's keyboard stops, by their accessible names, in order. */
function focusable(root: HTMLElement): string[] {
  return [
    ...bottomBar(root).querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    ),
  ]
    .filter(
      (element) =>
        element.tabIndex >= 0 &&
        !(element as HTMLButtonElement).disabled &&
        element.closest('[hidden], [inert]') === null,
    )
    .map(
      (element) =>
        element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
    )
}

function barButton(root: HTMLElement, label: string): HTMLButtonElement {
  const found = bottomBar(root).querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )
  if (!found) throw new Error(`no ${label} button in the bottom bar`)
  return found
}

function openMenu(name: string): HTMLElement {
  const menu = document.querySelector<HTMLElement>(
    `[role="menu"][aria-label="${name}"]`,
  )
  if (!menu) throw new Error(`the ${name} menu is not open`)
  return menu
}

function menuItems(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (item) =>
      item.querySelector('.item-label')?.textContent?.trim() ??
      item.textContent?.trim() ??
      '',
  )
}

beforeEach(() => {
  api.dictation = true
  api.screenshot = true
  api.capture.mockReset()
  api.uploads.length = 0
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
})

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
  localStorage.clear()
  resetDictationSettingsForTest()
  forgetKeptDictationsForTest()
  vi.restoreAllMocks()
})

describe('the composer bottom bar', () => {
  it('1 · keeps its own bar, with the microphone in the send slot: + 权限 模型 上下文 麦克风', async () => {
    const { root } = mount()
    await settle()
    expect(focusable(root)).toEqual([
      '添加附件与能力',
      '工作区',
      '模型与思考',
      '上下文 12.0k / 128.0k，已用 9%',
      '听写',
    ])
    // No send key next to the microphone while there is nothing to send.
    expect(bottomBar(root).querySelector('[aria-label="发送"]')).toBeNull()
  })

  it('puts send where the microphone was once there is a draft', async () => {
    const { root } = mount()
    await settle()
    typeInto(composerView(root), '你好')
    await settle()
    expect(focusable(root)).toEqual([
      '添加附件与能力',
      '工作区',
      '模型与思考',
      '上下文 12.0k / 128.0k，已用 9%',
      '发送',
    ])
    expect(barButton(root, '发送').getAttribute('data-variant')).toBe('primary')
  })

  it('shows send (not a microphone) where dictation is not available', async () => {
    api.dictation = false
    const { root } = mount()
    await settle()
    expect(bottomBar(root).querySelector('[aria-label="听写"]')).toBeNull()
    expect(barButton(root, '发送').disabled).toBe(true)
  })

  it('stops the running task from the send slot; a draft can wait in the queue', async () => {
    const { root, props } = mount({ busy: true })
    await settle()
    expect(bottomBar(root).querySelector('[aria-label="听写"]')).toBeNull()
    barButton(root, '停止').click()
    expect(props.onStop).toHaveBeenCalledOnce()
    typeInto(composerView(root), '下一步')
    await settle()
    expect(barButton(root, '加入队列').disabled).toBe(false)
    expect(barButton(root, '停止')).toBeTruthy()
  })

  it('2 · (dropped by the user: Plan stays the capsule and the + menu item) keeps the permission menu to the presets', async () => {
    const { root, props } = mount()
    await settle()
    const chip = bottomBar(root).querySelector<HTMLButtonElement>(
      '.permission-chip button',
    )!
    chip.click()
    await settle()
    const menu = openMenu('执行权限')
    expect(menuItems(menu)).toEqual(['只读', '工作区可写', '完全访问'])
    expect(menu.querySelector('[role="switch"]')).toBeNull()
    // Plan on: the capsule beside the chip, and × leaves Plan.
    props.control = { ...control, plan: true }
    props.lifecycleMode = 'plan'
    await settle()
    const capsule = barButton(root, '退出计划')
    expect(capsule.textContent?.trim()).toBe('Plan')
    capsule.click()
    expect(props.onDismissLifecycle).toHaveBeenCalledOnce()
  })

  it('3 · (dropped by the user: the context ring stays) shows the usage from the ring, and 添加模型… in the model menu', async () => {
    const { root } = mount()
    await settle()
    barButton(root, '上下文 12.0k / 128.0k，已用 9%').click()
    await settle()
    const usage = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="上下文用量"]',
    )
    expect(usage?.textContent).toContain('12.0k / 128.0k')
    expect(usage?.textContent).toContain('9%')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await settle()
    barButton(root, '模型与思考').click()
    await settle()
    const menu = openMenu('模型与思考')
    expect(menu.querySelector('[aria-label="上下文用量"]')).toBeNull()
    // A model with reasoning choices opens on the root pane: drill in.
    ;[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('模型'))!
      .click()
    await settle()
    expect(menu.querySelector('[data-add-model]')?.textContent?.trim()).toBe(
      '添加模型…',
    )
  })

  it('has no context ring when the context window is unknown', async () => {
    const { root } = mount({ contextMax: 0 })
    await settle()
    expect(root.querySelector('.context-meter')).toBeNull()
  })
})

describe('the + menu', () => {
  it('offers attachments, Skills and plugins, a screenshot, then Plan and Goal', async () => {
    const { root, props } = mount()
    await settle()
    barButton(root, '添加附件与能力').click()
    await settle()
    const menu = openMenu('添加')
    expect(menuItems(menu)).toEqual([
      '上传图片或文件',
      '插入 Skill 或插件',
      '截图',
      '计划模式',
      '目标模式',
    ])
    ;[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('计划模式'))!
      .click()
    expect(props.onActivatePlan).toHaveBeenCalledOnce()
  })

  it('has no screenshot where it cannot be taken', async () => {
    api.screenshot = false
    const { root } = mount()
    await settle()
    barButton(root, '添加附件与能力').click()
    await settle()
    expect(menuItems(openMenu('添加'))).not.toContain('截图')
  })

  it('attaches the screenshot that was taken', async () => {
    api.capture.mockResolvedValue(
      new File([new Uint8Array([137, 80, 78, 71])], '截图 2026-10-20.png', {
        type: 'image/png',
      }),
    )
    const { root, props } = mount()
    await settle()
    barButton(root, '添加附件与能力').click()
    await settle()
    const shot = [
      ...openMenu('添加').querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('截图'))!
    shot.click()
    await settle()
    expect(api.capture).toHaveBeenCalledOnce()
    expect(api.uploads.map((file) => file.name)).toEqual([
      '截图 2026-10-20.png',
    ])
    expect(root.querySelector('[aria-label="待发送附件"]')).not.toBeNull()
    expect(props.onError).not.toHaveBeenCalled()
  })

  it('attaches nothing when the screenshot is cancelled, and reports a failure', async () => {
    api.capture.mockResolvedValueOnce(null)
    const { root, props } = mount()
    await settle()
    const take = async () => {
      barButton(root, '添加附件与能力').click()
      await settle()
      ;[...openMenu('添加').querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('截图'))!
        .click()
      await settle()
    }
    await take()
    expect(api.uploads).toHaveLength(0)
    expect(props.onError).not.toHaveBeenCalled()
    api.capture.mockRejectedValueOnce(new Error('没有屏幕录制权限'))
    await take()
    expect(api.uploads).toHaveLength(0)
    expect(props.onError).toHaveBeenCalledWith('没有屏幕录制权限')
  })
})
