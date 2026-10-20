// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../../conversation/chatSnapshot'
import type { ChatNode } from '../../../conversation/types'

vi.mock('../../../api/http', () => ({ core: async () => [] }))
vi.mock('../../../composables/useAppContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../composables/useAppContext')
  >()),
  useAppContext: () => ({ boot: ref(null), showError: () => undefined }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: async () => undefined }),
  useRoute: () => ({ params: {}, query: {}, path: '/chat/s1', name: 'chat' }),
}))
import EnvironmentCard from './EnvironmentCard.vue'

let app: App | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  element?.remove()
  document.body.innerHTML = ''
})

const written: ChatNode = {
  key: 'tool:write',
  kind: 'tool',
  id: 'write',
  target: 'chat',
  anchorSeq: 1,
  visibility: 'visible',
  turn: 1,
  step: 1,
  data: {
    callId: 'write',
    name: 'write',
    argsRaw: '{}',
    turn: 1,
    step: 1,
    time: 0,
    status: 'settled',
    approvals: [],
    result: {
      seq: 2,
      time: 1,
      content: [{ type: 'text', text: 'created' }],
      isError: false,
      meta: { operation: 'create', path: '/work/report.pdf' },
    },
  },
}

function mount(props: Record<string, unknown> = {}) {
  element = document.createElement('div')
  document.body.append(element)
  app = createApp({
    render: () =>
      h(EnvironmentCard, {
        sessionId: 's1',
        snapshot: {
          ...EMPTY_CHAT_SNAPSHOT,
          order: [written.key],
          nodes: new Map([[written.key, written]]),
        },
        ...props,
      }),
  })
  app.mount(element)
}

async function settle() {
  for (let i = 0; i < 6; i++) await nextTick()
}

describe('EnvironmentCard (UI-S05: a read-only summary)', () => {
  it('stays within 600 lines', () => {
    const source = readFileSync(
      resolve(__dirname, 'EnvironmentCard.vue'),
      'utf8',
    )
    expect(source.split('\n').length).toBeLessThanOrEqual(600)
  })

  it('keeps three entries in 「⋯」 and none of the Git writes', async () => {
    const onClose = vi.fn()
    mount({ onClose })
    await settle()
    element!
      .querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
      .click()
    await settle()
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim(),
    )
    expect(items).toEqual(['复制项目路径', '在访达中显示', '隐藏此卡片'])
    // Without a project the path entries are there but unavailable.
    const [copy, reveal, hide] =
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect(copy.disabled).toBe(true)
    expect(reveal.disabled).toBe(true)
    hide.click()
    await settle()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('sums outputs up on one row, listing them in a menu with the loaded-history note', async () => {
    mount({ hasMore: true })
    await settle()
    const row = element!.querySelector<HTMLButtonElement>(
      '[data-row="outputs"]',
    )!
    expect(row.textContent).toContain('输出')
    expect(row.textContent).toContain('1')
    expect(element!.querySelector('[data-row="sources"]')).toBeNull()
    row.click()
    await settle()
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('已加载输出 · 1')
    expect(menu.textContent).toContain('report.pdf')
  })
})
