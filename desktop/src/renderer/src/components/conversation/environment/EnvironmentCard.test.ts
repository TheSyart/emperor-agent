// @vitest-environment jsdom
import { createApp, h, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../../conversation/chatSnapshot'
import type { ChatNode } from '../../../conversation/types'

vi.mock('../../../api/http', () => ({ core: async () => [] }))
vi.mock('../../../composables/useAppContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../composables/useAppContext')
  >()),
  useAppContext: () => ({ boot: ref(null) }),
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
})

describe('EnvironmentCard resource scope', () => {
  it('shows the loaded-history notice when the window contains outputs without sources', () => {
    const output: ChatNode = {
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
    const snapshot = {
      ...EMPTY_CHAT_SNAPSHOT,
      order: [output.key],
      nodes: new Map([[output.key, output]]),
    }
    element = document.createElement('div')
    document.body.append(element)
    app = createApp({
      render: () =>
        h(EnvironmentCard, { sessionId: 's1', snapshot, hasMore: true }),
    })
    app.mount(element)
    expect(element.querySelector('[data-section="outputs"]')).not.toBeNull()
    expect(element.querySelector('[data-section="sources"]')).toBeNull()
    expect(
      element.querySelector('.resource-scope')?.textContent ?? '',
    ).toContain('已加载的会话资源')
  })
})
