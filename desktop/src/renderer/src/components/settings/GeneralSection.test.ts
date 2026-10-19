// @vitest-environment jsdom
// FIX-01: 设置 › 常规 keeps an archive that tells a failed load from an
// empty one, and a 最近删除 list where deleted sessions can be restored or
// deleted for good (after a confirmation).
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CONTEXT_KEY } from '../../composables/useAppContext'
import { answerConfirmsForTest } from '../ui/confirm'
import GeneralSection from './GeneralSection.vue'

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

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await nextTick()
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(GeneralSection) })
  app.provide(APP_CONTEXT_KEY, {
    boot: ref(null),
    runtimeText: () => '在线',
    showToast,
    showError,
  } as never)
  app.mount(container)
  await settle()
  return container
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

describe('GeneralSection archive (FIX-01 8)', () => {
  it('shows an error and 重试 when the archive cannot load, not 暂无归档对话', async () => {
    session.loadArchived.mockRejectedValueOnce(new Error('索引损坏'))
    const root = await mount()
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
    expect(
      root.querySelector('[data-group="archived"]')?.textContent,
    ).toContain('暂无归档对话')
  })
})

describe('GeneralSection 最近删除 (FIX-01 2)', () => {
  it('lists deleted sessions and restores one', async () => {
    session.listDeleted.mockResolvedValue([trashed])
    const root = await mount()
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
