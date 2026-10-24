// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { core } from '../../../api/http'
import { setUiPreference } from '../../../composables/useUiPreferences'
import ResourceDetails from './ResourceDetails.vue'
import { displayResource } from './resourceModel'
vi.mock('../../../api/http', () => ({ core: vi.fn() }))
let cleanup = () => {}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
async function flush() {
  for (let i = 0; i < 6; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}
function mount() {
  const root = document.createElement('div')
  document.body.append(root)
  const props = reactive({
    resource: displayResource('https://github.com/a/b', '', 'm1')!,
    sessionId: 's1',
  })
  const app = createApp({ render: () => h(ResourceDetails, props) })
  app.mount(root)
  cleanup = () => {
    app.unmount()
    root.remove()
  }
  return props
}
describe('ResourceDetails lazy Core bridge', () => {
  // These cases exercise real site icons, which are opt-in (W-3).
  beforeEach(() => setUiPreference('siteIconService', true))
  afterEach(() => setUiPreference('siteIconService', true))
  it('shows a readable network failure and keeps the original open action', async () => {
    vi.mocked(core).mockImplementation((async (name: string) =>
      name === 'references.resolve'
        ? {
            id: 'ref-1',
            kind: 'web',
            tooltip: 'https://github.com/a/b',
            available: true,
            actions: ['open_external'],
          }
        : { state: 'error', reason: 'timeout', updatedAt: 1 }) as typeof core)
    mount()
    await flush()
    const dialog = document.querySelector('[data-resource-dialog]')!
    expect(dialog.textContent).toContain('加载超时')
    expect(dialog.textContent).toContain('重新加载')
    expect(
      [...dialog.querySelectorAll('button')].some(
        (button) => button.textContent?.includes('打开') && !button.disabled,
      ),
    ).toBe(true)
  })
  it('resolves the owning message before preview and escapes remote titles', async () => {
    const calls: Array<[string, unknown]> = []
    vi.mocked(core).mockImplementation((async (
      name: string,
      input: unknown,
    ) => {
      calls.push([name, input])
      return name === 'references.resolve'
        ? {
            id: 'ref-1',
            kind: 'web',
            label: 'repo',
            tooltip: 'https://github.com/a/b',
            available: true,
            actions: ['open_external'],
          }
        : {
            state: 'ready',
            title: '<img src=x onerror=alert(1)>',
            description: 'description',
            updatedAt: 1,
          }
    }) as typeof core)
    mount()
    await flush()
    expect(calls).toEqual([
      [
        'references.resolve',
        {
          sessionId: 's1',
          sourceMessageId: 'm1',
          href: 'https://github.com/a/b',
          label: 'a/b',
        },
      ],
      ['references.preview', { sessionId: 's1', referenceId: 'ref-1' }],
    ])
    expect(
      document.querySelector('[data-resource-dialog] h2')?.textContent,
    ).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('[data-resource-dialog] img')).toBeNull()
  })
  it('does not start an old-session preview after delayed reference resolution', async () => {
    let finish!: (value: unknown) => void
    const calls: string[] = []
    vi.mocked(core).mockImplementation((async (
      name: string,
      input: { sessionId: string },
    ) => {
      calls.push(`${name}:${input.sessionId}`)
      if (name === 'references.resolve' && input.sessionId === 's1')
        return new Promise<unknown>((resolve) => {
          finish = resolve
        })
      return name === 'references.resolve'
        ? {
            id: 'ref-2',
            kind: 'web',
            available: true,
            tooltip: 'https://b.test',
            actions: ['open_external'],
          }
        : { state: 'ready', title: '新会话', updatedAt: 2 }
    }) as typeof core)
    const props = mount()
    props.sessionId = 's2'
    props.resource = displayResource('https://b.test', '', 'm2')!
    await flush()
    finish({
      id: 'ref-1',
      kind: 'web',
      available: true,
      tooltip: 'https://github.com/a/b',
      actions: ['open_external'],
    })
    await flush()
    expect(
      calls.filter((call) => call.startsWith('references.preview:')),
    ).toEqual(['references.preview:s2'])
    expect(calls).toContain('references.siteIcon:s2')
    expect(
      calls.filter((call) => call === 'references.resolve:s1'),
    ).toHaveLength(1)
    expect(
      document.querySelector('[data-resource-dialog] h2')?.textContent,
    ).toBe('新会话')
  })
})
