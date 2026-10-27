// @vitest-environment jsdom
/**
 * BRD-05: 设置 › 常规 › 外观 › 皮肤 — the skins main lists (each with a
 * preview), 使用, 从文件夹导入 (asking before a replace, showing why a
 * folder is refused) and 删除 for imported ones.
 */
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SkinListEntry,
  SkinView,
} from '../../../../../shared/skin-contract'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('../../ui/confirm', () => ({ confirm }))

function view(
  id: string,
  name: string,
  extra: Partial<SkinView> = {},
): SkinView {
  return {
    id,
    name,
    author: 'Emperor',
    license: '',
    description: `${name}的说明`,
    official: true,
    base: 'auto',
    tokens: {},
    reset: { light: {}, dark: {} },
    fonts: { heading: 'system' },
    slots: {},
    preview: {
      light: {
        canvas: '246 245 242',
        base: '255 255 255',
        raised: '247 246 243',
        text1: '28 27 25',
        text2: '95 93 88',
        brand: '156 111 36',
      },
      dark: {
        canvas: '20 20 19',
        base: '26 26 25',
        raised: '33 33 32',
        text1: '236 236 234',
        text2: '168 166 161',
        brand: '212 170 94',
      },
    },
    ...extra,
  }
}

const OFFICIAL = [
  view('yushufang', '御书房', {
    slots: { sidebarFooter: 'app://skin/yushufang/robe.webp?v=1' },
  }),
  view('zhupi', '朱批', {
    base: 'light',
    reset: { light: {} },
    tokens: { '--brand': '184 50 31' },
  }),
  view('richang', '日常'),
]
const PAPER = view('paper', '宣纸', { official: false, author: '社区' })

let entries: SkinListEntry[] = []
const bridge = {
  skinList: vi.fn(async () => ({ ok: true, skins: entries })),
  skinGet: vi.fn(async (id: string) => {
    const found = entries.find((entry) => entry.ok && entry.id === id)
    return found && found.ok
      ? { ok: true, skin: found.view }
      : { ok: false, missing: true }
  }),
  skinImportPick: vi.fn(),
  skinImport: vi.fn(),
  skinRemove: vi.fn(async (id: string) => {
    entries = entries.filter((entry) => entry.id !== id)
    return { ok: true }
  }),
}

let app: App | null = null
let container: HTMLDivElement | null = null
const showToast = vi.fn()
const showError = vi.fn()

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  const { default: SkinsPage } = await import('./SkinsPage.vue')
  // Fresh modules after resetModules: take the keys from the same graph.
  const { APP_CONTEXT_KEY } = await import('../../../composables/useAppContext')
  const { createSettingsHeader, SETTINGS_HEADER_KEY } =
    await import('../settingsHeader')
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(SkinsPage) })
  app.provide(APP_CONTEXT_KEY, { showToast, showError } as never)
  app.provide(SETTINGS_HEADER_KEY, createSettingsHeader())
  app.mount(container)
  await settle()
  return container
}

function card(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-skin-card="${id}"]`)!
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  entries = [
    ...OFFICIAL.map((v) => ({ ok: true as const, id: v.id, view: v })),
    { ok: true as const, id: 'paper', view: PAPER },
    {
      ok: false as const,
      id: 'broken',
      name: 'broken',
      official: false as const,
      problems: [
        '「hero.webp」的文件头不是 PNG 或 WebP（只看文件内容，不看扩展名）',
      ],
    },
  ]
  for (const fn of Object.values(bridge)) fn.mockClear()
  confirm.mockReset()
  showToast.mockReset()
  showError.mockReset()
  ;(window as unknown as { emperor?: unknown }).emperor = bridge
  const state = await import('../../../skin/skinState')
  state.initSkin()
  await settle()
})

afterEach(async () => {
  app?.unmount()
  container?.remove()
  app = null
  ;(await import('../../../skin/skinState')).resetSkinForTests()
  delete (window as unknown as { emperor?: unknown }).emperor
})

describe('设置 › 常规 › 外观 › 皮肤', () => {
  it('lists the official skins first, then imported ones, each with a preview', async () => {
    const root = await mount()
    expect(
      [...root.querySelectorAll<HTMLElement>('[data-skin-card]')].map(
        (el) => el.dataset.skinCard,
      ),
    ).toEqual(['yushufang', 'zhupi', 'richang', 'paper', 'broken'])
    expect(card(root, 'yushufang').textContent).toContain('使用中')
    expect(card(root, 'yushufang').textContent).toContain('官方')
    expect(card(root, 'zhupi').textContent).toContain('只有浅色')
    expect(card(root, 'richang').textContent).toContain('浅色和深色')
    expect(card(root, 'paper').textContent).toContain('社区')
    expect(
      card(root, 'zhupi').querySelector('[data-skin-preview]'),
    ).not.toBeNull()
    expect(card(root, 'broken').textContent).toContain('无法使用')
    expect(card(root, 'broken').textContent).toContain('hero.webp')
    expect(root.textContent).toContain(
      '对话正文、代码、改动对比、权限确认、费用和登录界面保持原样',
    )
  })

  it('uses a skin', async () => {
    const root = await mount()
    button(card(root, 'zhupi'), '使用').click()
    await settle()
    expect(document.documentElement.dataset.skin).toBe('zhupi')
    expect(card(root, 'zhupi').textContent).toContain('使用中')
    expect(card(root, 'yushufang').textContent).not.toContain('使用中')
  })

  it('imports a folder, asking before it replaces a skin with the same id', async () => {
    const root = await mount()
    bridge.skinImportPick.mockResolvedValueOnce({
      ok: true,
      staged: {
        stageId: 's_0123456789ab',
        skin: { ...PAPER, name: '新宣纸' },
        replaces: true,
      },
    })
    bridge.skinImport.mockImplementationOnce(async () => {
      entries = entries.map((entry) =>
        entry.id === 'paper'
          ? { ok: true, id: 'paper', view: { ...PAPER, name: '新宣纸' } }
          : entry,
      )
      return { ok: true, skin: { ...PAPER, name: '新宣纸' } }
    })
    confirm.mockResolvedValueOnce(true)
    button(root, '从文件夹导入…').click()
    await settle()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '替换皮肤「新宣纸」？',
        confirmLabel: '替换',
      }),
    )
    expect(bridge.skinImport).toHaveBeenCalledWith('s_0123456789ab')
    expect(showToast).toHaveBeenCalledWith('已导入皮肤「新宣纸」')
    expect(card(root, 'paper').textContent).toContain('新宣纸')
  })

  it('does not import when the replace is declined', async () => {
    const root = await mount()
    bridge.skinImportPick.mockResolvedValueOnce({
      ok: true,
      staged: { stageId: 's_0123456789ab', skin: PAPER, replaces: true },
    })
    confirm.mockResolvedValueOnce(false)
    button(root, '从文件夹导入…').click()
    await settle()
    expect(bridge.skinImport).not.toHaveBeenCalled()
  })

  it('shows why a folder cannot be imported', async () => {
    const root = await mount()
    bridge.skinImportPick.mockResolvedValueOnce({
      ok: false,
      problems: [
        '令牌「--fs-s」不能改：皮肤只能改颜色（表面、文字、描边、品牌和强调色）',
        '缺少 skin.json',
      ],
    })
    button(root, '从文件夹导入…').click()
    await settle()
    const notice = root.querySelector<HTMLElement>(
      '[data-skin-import-problems]',
    )!
    expect(notice.textContent).toContain('没能导入')
    expect(notice.textContent).toContain('「--fs-s」')
    expect(notice.textContent).toContain('缺少 skin.json')
  })

  it('deletes an imported skin after asking, and leaves it when it was in use', async () => {
    const root = await mount()
    button(card(root, 'paper'), '使用').click()
    await settle()
    expect(document.documentElement.dataset.skin).toBe('paper')
    expect(
      card(root, 'zhupi').querySelector('button')?.textContent,
    ).not.toContain('删除')
    confirm.mockResolvedValueOnce(true)
    button(card(root, 'paper'), '删除').click()
    await settle()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '删除皮肤「宣纸」？', tone: 'danger' }),
    )
    expect(bridge.skinRemove).toHaveBeenCalledWith('paper')
    expect(root.querySelector('[data-skin-card="paper"]')).toBeNull()
    expect(document.documentElement.dataset.skin).toBe('yushufang')
  })
})
