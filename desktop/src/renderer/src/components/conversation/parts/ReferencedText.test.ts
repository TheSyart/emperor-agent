// @vitest-environment jsdom
import { computed, createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_CONTEXT_KEY } from '../../../composables/useAppContext'
import type { MessageReference, PluginSummary } from '../../../types'
import ReferencedText from './ReferencedText.vue'

let app: App | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
})

function plugin(patch: Partial<PluginSummary>): PluginSummary {
  return {
    pluginId: 'github',
    displayName: 'GitHub',
    description: '与 GitHub 集成',
    logo: 'app://plugin-assets/managed/github/logo?v=abcd1234',
    scope: 'managed',
    activation: 'active',
    effective: true,
    enabled: true,
    toggleable: true,
    ...patch,
  } as PluginSummary
}

const plugins = ref<PluginSummary[]>([
  plugin({}),
  plugin({
    pluginId: 'hello-kit',
    displayName: 'Hello Kit',
    logo: null,
    scope: 'user',
  }),
])

function mount(text: string, references?: MessageReference[]) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ render: () => h(ReferencedText, { text, references }) })
  app.provide(APP_CONTEXT_KEY, {
    commands: computed(() => []),
    boot: ref({ plugins: plugins.value }),
  } as never)
  app.mount(container)
  return container
}

describe('ReferencedText plugin chips', () => {
  it('shows a usable plugin with its logo, and one that is gone greyed', async () => {
    const root = mount('看看 @github 和 @hello-kit 还有 @old-kit', [
      { kind: 'plugin', id: 'github', label: 'GitHub', start: 3, end: 10 },
      {
        kind: 'plugin',
        id: 'hello-kit',
        label: 'Hello Kit',
        start: 13,
        end: 23,
      },
      { kind: 'plugin', id: 'old-kit', label: 'Old Kit', start: 27, end: 35 },
    ])
    await nextTick()
    const chips = [...root.querySelectorAll<HTMLElement>('.reference-chip')]
    expect(
      chips.map((chip) => [
        chip.dataset.kind,
        chip.textContent?.trim(),
        chip.getAttribute('aria-label'),
        chip.hasAttribute('data-unavailable'),
      ]),
    ).toEqual([
      ['plugin', 'GitHub', '插件 GitHub', false],
      // No logo: the monogram tile stands in.
      ['plugin', 'HHello Kit', '插件 Hello Kit', false],
      ['plugin', 'Old Kit', '插件 Old Kit（已不可用）', true],
    ])
    expect(chips[0]!.querySelector('img')?.getAttribute('src')).toBe(
      'app://plugin-assets/managed/github/logo?v=abcd1234',
    )
  })

  it('rebuilds chips of older messages from the plugins it knows', async () => {
    const root = mount('用 @github 看看')
    await nextTick()
    const chip = root.querySelector<HTMLElement>('.reference-chip')!
    expect(chip.dataset.kind).toBe('plugin')
    expect(chip.getAttribute('aria-label')).toBe('插件 GitHub')
  })
})
