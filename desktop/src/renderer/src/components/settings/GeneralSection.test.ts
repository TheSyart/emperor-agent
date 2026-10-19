// @vitest-environment jsdom
// UI-S07: 设置 › 常规 is 外观 (主题, 桌宠), 会话, 开发者 and the way to the
// archive. FIX-01: the archive tells a failed load from an empty one, and
// 最近删除 restores deleted sessions or deletes them for good (after a
// confirmation).
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import {
  reloadUiPreferences,
  UI_PREFERENCES_STORAGE_KEY,
  uiPreferences,
} from '../../composables/useUiPreferences'
import { answerConfirmsForTest } from '../ui/confirm'
import GeneralSection from './GeneralSection.vue'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))

const browser = vi.hoisted(() => ({
  preferences: { value: { linkTarget: 'system' } },
  update: vi.fn(async () => {}),
}))
vi.mock('../../composables/useBrowserPreferences', () => ({
  useBrowserPreferences: () => browser,
}))

const session = vi.hoisted(() => ({
  loadArchived: vi.fn(),
  listDeleted: vi.fn(),
  restoreDeleted: vi.fn(),
  purgeDeleted: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  sessionActionError: { value: '' },
}))
vi.mock('../../composables/useSession', () => ({
  useSession: () => session,
}))

let app: App | null = null
let container: HTMLDivElement | null = null
const showToast = vi.fn()
const showError = vi.fn()
const setDesktopPetEnabled = vi.fn(async () => {})
const pet = ref({ enabled: false, running: false })

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(GeneralSection) })
  app.provide(APP_CONTEXT_KEY, {
    boot: ref({ model: 'demo-model', projects: [], desktopPet: pet.value }),
    runtimeText: () => '在线',
    showToast,
    showError,
    setDesktopPetEnabled,
    runSafely: async (task: () => Promise<void>) => await task(),
  } as never)
  app.mount(container)
  await settle()
  return container
}

/** The archive lives one row away from the main page. */
async function openArchive(root: ParentNode): Promise<void> {
  root
    .querySelector<HTMLButtonElement>('[data-testid="open-archived"]')
    ?.click()
  await settle()
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

const trashed = {
  id: 's-gone',
  title: '旧草稿',
  mode: 'chat' as const,
  project_name: null,
  project_path: null,
  deleted_at: '2026-10-18T08:00:00.000Z',
}

beforeEach(() => {
  localStorage.removeItem(UI_PREFERENCES_STORAGE_KEY)
  reloadUiPreferences()
  pet.value = { enabled: false, running: false }
  core.mockImplementation(async (op: string) =>
    op === 'sessions.defaults' ? { permission: 'workspace-write' } : {},
  )
  session.loadArchived.mockResolvedValue([])
  session.listDeleted.mockResolvedValue([])
  session.restoreDeleted.mockResolvedValue({ id: 's-gone' })
  session.purgeDeleted.mockResolvedValue(true)
})

afterEach(() => {
  answerConfirmsForTest(null)
  app?.unmount()
  app = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('GeneralSection main page (UI-S07)', () => {
  it('puts 主题 and the 桌宠 switch under 外观', async () => {
    const root = await mount()
    const appearance = root.querySelector('[data-group="appearance"]')!
    expect(
      [
        ...appearance.querySelectorAll('[aria-label="主题"] [role="radio"]'),
      ].map((option) => option.textContent?.trim()),
    ).toEqual(['跟随系统', '浅色', '深色'])
    const petSwitch =
      appearance.querySelector<HTMLButtonElement>('#general-pet')
    expect(petSwitch).not.toBeNull()
    expect(petSwitch?.getAttribute('aria-checked')).toBe('false')
    petSwitch?.click()
    await settle()
    expect(setDesktopPetEnabled).toHaveBeenCalledWith(true)
  })

  it('has 显示轨迹 and 显示系统步骤 under 开发者, both off by default', async () => {
    const root = await mount()
    const developer = root.querySelector('[data-group="developer"]')!
    const trajectory = developer.querySelector<HTMLButtonElement>(
      '#general-show-trajectory',
    )
    const steps = developer.querySelector<HTMLButtonElement>(
      '#general-system-steps',
    )
    expect(trajectory?.getAttribute('aria-checked')).toBe('false')
    expect(steps?.getAttribute('aria-checked')).toBe('false')
    trajectory?.click()
    await settle()
    expect(uiPreferences().showTrajectory).toBe(true)
    expect(uiPreferences().showSystemSteps).toBe(false)
  })

  it('sets the new-session permission, 处理过程 and 网页链接 under 会话', async () => {
    const root = await mount()
    const group = root.querySelector('[data-group="session"]')!
    expect(core).toHaveBeenCalledWith('sessions.defaults')
    expect(group.querySelector('#general-permission')).not.toBeNull()
    expect(group.querySelector('#general-process')).not.toBeNull()
    expect(group.querySelector('#general-link-target')).not.toBeNull()
    expect(group.textContent).toContain('新会话的权限')
    expect(group.textContent).toContain('处理过程')
    expect(group.textContent).toContain('网页链接')
  })

  it('leaves the runtime facts to 诊断', async () => {
    const root = await mount()
    for (const gone of ['运行状态', '当前模型', '已绑定项目'])
      expect(root.textContent).not.toContain(gone)
    expect(root.querySelector('[data-testid="runtime-status"]')).toBeNull()
  })
})

describe('GeneralSection archive (FIX-01 8)', () => {
  it('opens the archive from its row on the main page', async () => {
    const root = await mount()
    expect(root.querySelector('[data-group="archived"]')).toBeNull()
    expect(session.loadArchived).not.toHaveBeenCalled()
    await openArchive(root)
    expect(root.querySelector('[data-group="archived"]')).not.toBeNull()
    expect(root.querySelector('[data-group="deleted"]')).not.toBeNull()
    expect(root.querySelector('[data-group="appearance"]')).toBeNull()
  })

  it('shows an error and 重试 when the archive cannot load, not 暂无归档对话', async () => {
    session.loadArchived.mockRejectedValueOnce(new Error('索引损坏'))
    const root = await mount()
    await openArchive(root)
    const archive = root.querySelector('[data-group="archived"]')!
    expect(archive.textContent).toContain('索引损坏')
    expect(archive.textContent).not.toContain('暂无归档对话')
    session.loadArchived.mockResolvedValueOnce([
      { id: 'a1', title: '归档一', archived_at: '2026-10-01' },
    ])
    button(archive, '重试').click()
    await settle()
    expect(
      root.querySelectorAll('[data-testid="archived-session"]'),
    ).toHaveLength(1)
  })

  it('says 暂无归档对话 only when the archive really is empty', async () => {
    const root = await mount()
    await openArchive(root)
    expect(
      root.querySelector('[data-group="archived"]')?.textContent,
    ).toContain('暂无归档对话')
  })
})

describe('GeneralSection 最近删除 (FIX-01 2)', () => {
  it('lists deleted sessions and restores one', async () => {
    session.listDeleted.mockResolvedValue([trashed])
    const root = await mount()
    await openArchive(root)
    const group = root.querySelector('[data-group="deleted"]')!
    expect(group.textContent).toContain('旧草稿')
    session.listDeleted.mockResolvedValue([])
    button(group, '恢复').click()
    await settle()
    expect(session.restoreDeleted).toHaveBeenCalledWith('s-gone')
    expect(showToast).toHaveBeenCalledWith('已恢复「旧草稿」')
    expect(
      root.querySelector('[data-group="deleted"]')?.textContent,
    ).not.toContain('旧草稿')
  })

  it('deletes for good only after a danger confirmation', async () => {
    session.listDeleted.mockResolvedValue([trashed])
    const responder = vi.fn((): boolean => false)
    answerConfirmsForTest(responder)
    const root = await mount()
    await openArchive(root)
    const group = root.querySelector('[data-group="deleted"]')!
    button(group, '永久删除').click()
    await settle()
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'danger' }),
    )
    expect(session.purgeDeleted).not.toHaveBeenCalled()
    responder.mockReturnValue(true)
    button(group, '永久删除').click()
    await settle()
    expect(session.purgeDeleted).toHaveBeenCalledWith('s-gone')
  })
})
