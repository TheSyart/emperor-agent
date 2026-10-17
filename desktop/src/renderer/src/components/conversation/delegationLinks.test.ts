// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ExternalAgentStream from './tools/ExternalAgentStream.vue'
import { createExpansionStore, provideChatContext } from './chatContext'
const core = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({
  invokeCore: core,
  revealReference: vi.fn(),
  openExternal: vi.fn(),
}))
let app: App | undefined, root: HTMLDivElement
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
}
afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.clearAllMocks()
})
it('scopes inline images beneath an internal parent to the owning root and delegation cwd', async () => {
  core.mockImplementation(async (key: string) =>
    key === 'references.resolve'
      ? {
          id: 'ref-child',
          kind: 'external_file',
          available: true,
          tooltip: '/delegated/sun.png',
        }
      : {
          kind: 'image',
          truncated: false,
          mimeType: 'image/png',
          dataBase64: 'AQ==',
        },
  )
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    setup() {
      const expansion = createExpansionStore()
      expansion.set('external:call', true)
      provideChatContext({
        sessionId: () => 'sub-parent',
        rootSessionId: () => '78abd5498fc6469f',
        expansion,
        actions: {
          inspect: () => {},
          openSubagent: () => {},
          editMessage: () => {},
        },
      })
      return () =>
        h(ExternalAgentStream, {
          callId: 'call',
          run: {
            delegationId: 'dlg-sun',
            runId: 'dgr-sun',
            backend: 'codex',
            title: '画太阳',
            phase: 'completed',
            text: '![太阳](sun.png)',
            activity: [],
          },
        })
    },
  })
  app.mount(root)
  await settle()
  expect(core).toHaveBeenCalledWith(
    'references.resolve',
    expect.objectContaining({
      sessionId: '78abd5498fc6469f',
      delegationId: 'dlg-sun',
      href: 'sun.png',
    }),
  )
  expect(core).toHaveBeenCalledWith('references.image', {
    sessionId: '78abd5498fc6469f',
    referenceId: 'ref-child',
  })
  expect(root.querySelector('img.md-image-preview')?.getAttribute('src')).toBe(
    'data:image/png;base64,AQ==',
  )
  expect(root.textContent).toContain('画太阳')
  expect(root.textContent).toContain('Codex')
})
it('retries an early missing inline image when the same run settles', async () => {
  const { reactive } = await import('vue')
  const run = reactive({
    delegationId: 'dlg-late-image',
    runId: 'dgr-late-image',
    backend: 'codex' as const,
    phase: 'outcome_unknown',
    text: '![稍后生成](sun.png)',
    activity: [],
  })
  let available = false
  core.mockImplementation(async (key: string) =>
    key === 'references.resolve'
      ? {
          id: 'ref-late',
          kind: 'external_file',
          available,
          tooltip: '/delegated/sun.png',
        }
      : {
          kind: 'image',
          truncated: false,
          mimeType: 'image/png',
          dataBase64: 'AQ==',
        },
  )
  root = document.createElement('div')
  document.body.append(root)
  app = createApp({
    setup() {
      const expansion = createExpansionStore()
      expansion.set('external:late-call', true)
      provideChatContext({
        sessionId: () => 'root',
        expansion,
        actions: {
          inspect: () => {},
          openSubagent: () => {},
          editMessage: () => {},
        },
      })
      return () => h(ExternalAgentStream, { callId: 'late-call', run })
    },
  })
  app.mount(root)
  await settle()
  expect(root.querySelector('img.md-image-preview')).toBeNull()
  expect(
    core.mock.calls.filter(([key]) => key === 'references.resolve'),
  ).toHaveLength(1)
  available = true
  run.phase = 'completed'
  await settle()
  expect(root.querySelector('img.md-image-preview')?.getAttribute('src')).toBe(
    'data:image/png;base64,AQ==',
  )
})
