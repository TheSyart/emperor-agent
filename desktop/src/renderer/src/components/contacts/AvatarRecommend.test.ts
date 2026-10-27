// @vitest-environment jsdom
/**
 * GRP-04 (D21): the recommended avatar with 「换一个」 and 「从头像库选…」
 * (card tests: 「换一个」不会换回同一个；选「在用」的头像会提示但可以保存).
 */
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactAvatar } from '@emperor/core/api'

const { core } = vi.hoisted(() => ({ core: vi.fn() }))
vi.mock('../../api/http', () => ({ core }))
const { loadManifest } = vi.hoisted(() => ({ loadManifest: vi.fn() }))
vi.mock('../ui/contactAvatars', async (original) => ({
  ...(await original<typeof import('../ui/contactAvatars')>()),
  loadContactAvatarManifest: loadManifest,
}))

const { default: AvatarRecommend } = await import('./AvatarRecommend.vue')

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

let app: App | null = null
let container: HTMLDivElement | null = null
const avatar = ref<ContactAvatar>({ kind: 'library', id: 'AV-01-4' })

function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(() =>
    h(AvatarRecommend, {
      modelValue: avatar.value,
      'onUpdate:modelValue': (value: ContactAvatar) => (avatar.value = value),
      templateId: 'security-auditor',
      inUse: { 'AV-01-2': '审稿人' },
      origin: 'recommended',
    }),
  )
  app.mount(container)
}

function button(name: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function shownId(): string {
  return (
    document
      .querySelector<HTMLElement>('[data-avatar-recommend] .ds-avatar')
      ?.getAttribute('data-avatar') ?? ''
  )
}

beforeEach(() => {
  avatar.value = { kind: 'library', id: 'AV-01-4' }
  core.mockReset()
  loadManifest.mockReset()
  loadManifest.mockResolvedValue([
    {
      id: 'AV-01-2',
      sheet: 'AV-01',
      rect: [192, 0, 192, 192],
      theme: 'engineering',
      label: '代码审稿人',
      tint: '#ECDAD0',
    },
    {
      id: 'AV-01-4',
      sheet: 'AV-01',
      rect: [0, 192, 192, 192],
      theme: 'engineering',
      label: '安全审计',
      tint: '#F0E4C8',
    },
  ])
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
})

describe('AvatarRecommend', () => {
  it('shows the recommendation and why', async () => {
    mount()
    await flush()
    expect(shownId()).toBe('AV-01-4')
    const text = document.querySelector('[data-avatar-recommend]')!.textContent!
    expect(text).toContain('推荐')
    expect(text).toContain('工程')
    expect(text).toContain('跳过别的联系人已在用的')
  })

  it('换一个 draws from the theme and never offers one again', async () => {
    const picks = ['AV-02-3', 'AV-01-8']
    core.mockImplementation(async (op: string) => {
      if (op === 'contacts.recommendAvatar')
        return { id: picks.shift(), theme: 'engineering' }
      throw new Error(op)
    })
    mount()
    await flush()
    button('换一个').click()
    await flush()
    expect(core).toHaveBeenLastCalledWith('contacts.recommendAvatar', {
      templateId: 'security-auditor',
      exclude: ['AV-01-4'],
    })
    expect(avatar.value).toEqual({ kind: 'library', id: 'AV-02-3' })
    expect(shownId()).toBe('AV-02-3')
    button('换一个').click()
    await flush()
    // Everything offered so far, the one on screen last.
    expect(core).toHaveBeenLastCalledWith('contacts.recommendAvatar', {
      templateId: 'security-auditor',
      exclude: ['AV-01-4', 'AV-02-3'],
    })
    expect(avatar.value).toEqual({ kind: 'library', id: 'AV-01-8' })
    expect(
      document.querySelector('[data-avatar-recommend]')!.textContent,
    ).toContain('换了一个')
  })

  it('picks from the library, an avatar in use too, and says who uses it', async () => {
    mount()
    await flush()
    expect(loadManifest).not.toHaveBeenCalled()
    button('从头像库选…').click()
    await flush()
    expect(loadManifest).toHaveBeenCalledTimes(1)
    document.querySelector<HTMLElement>('[data-avatar-cell="AV-01-2"]')!.click()
    await flush()
    expect(avatar.value).toEqual({ kind: 'library', id: 'AV-01-2' })
    const text = document.querySelector('[data-avatar-recommend]')!.textContent!
    expect(text).toContain('代码审稿人')
    expect(text).toContain('「审稿人」也在用这个头像')
  })
})
