// @vitest-environment jsdom
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  watch,
  type App,
  type PropType,
} from 'vue'
import { provideDelegationLinks } from './delegationLinks'
import ConversationMarkdown from './parts/ConversationMarkdown.vue'
import { afterEach, expect, it, vi } from 'vitest'

interface RunOutput {
  delegationId: string
  runId: string
  phase: string
  text: string
}

/**
 * A run's output as the run page shows it (ExternalAgentConversation):
 * links scoped to the root and the delegation, refreshed per run and phase.
 */
const RunOutputHarness = defineComponent({
  props: {
    rootSessionId: { type: String, required: true },
    run: { type: Object as PropType<RunOutput>, required: true },
  },
  setup(props) {
    const { click, links } = provideDelegationLinks(() => ({
      sessionId: props.rootSessionId,
      delegationId: props.run.delegationId,
    }))
    watch([() => props.run.runId, () => props.run.phase], () => links.refresh())
    return () =>
      h('div', { onClickCapture: click }, [
        h(ConversationMarkdown, { text: props.run.text }),
      ])
  },
})
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
it('scopes inline images of a run to the owning root and the delegation', async () => {
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
    render: () =>
      h(RunOutputHarness, {
        rootSessionId: '78abd5498fc6469f',
        run: {
          delegationId: 'dlg-sun',
          runId: 'dgr-sun',
          phase: 'completed',
          text: '![太阳](sun.png)',
        },
      }),
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
})
it('retries an early missing inline image when the same run settles', async () => {
  const { reactive } = await import('vue')
  const run = reactive({
    delegationId: 'dlg-late-image',
    runId: 'dgr-late-image',
    phase: 'outcome_unknown',
    text: '![稍后生成](sun.png)',
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
    render: () => h(RunOutputHarness, { rootSessionId: 'root', run }),
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

it('keeps archived-root references inert and clears prior image capabilities', async () => {
  const enabled = ref(true)
  core.mockImplementation(async (key: string) =>
    key === 'references.resolve'
      ? {
          id: 'ref-one',
          kind: 'external_file',
          available: true,
          tooltip: '/work/sun.png',
          actions: ['reveal'],
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
      const { click } = provideDelegationLinks(
        () => ({ sessionId: 'root', delegationId: 'dlg-one' }),
        () => enabled.value,
      )
      return () =>
        h('div', { onClickCapture: click }, [
          h(ConversationMarkdown, {
            text: '![太阳](sun.png) [文件](result.txt)',
          }),
        ])
    },
  })
  app.mount(root)
  await settle()
  expect(root.querySelector('img.md-image-preview')).not.toBeNull()
  core.mockClear()
  enabled.value = false
  await settle()
  expect(root.querySelector('img.md-image-preview')).toBeNull()
  root.querySelector<HTMLAnchorElement>('a.md-link-chip')!.click()
  await settle()
  expect(core).not.toHaveBeenCalled()
})
