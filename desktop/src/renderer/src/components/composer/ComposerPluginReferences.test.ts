// @vitest-environment jsdom
/**
 * RF-03: plugin chips in the rich composer — the `@` list (plugins only,
 * usable first, the rest greyed and opening their detail), typing, the +
 * menu's 插件 group, the chip's logo, and what a send carries.
 */
import { createApp, nextTick, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashPaletteItem } from '../../commands'
import type { ChatSendPayload, PluginSummary } from '../../types'
import Composer from './ComposerCard.vue'
import {
  composerView,
  pressKey,
  typeInto,
  visibleText,
} from './editor/editorTesting'

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
    pluginId: 'hello-kit',
    name: 'hello-kit',
    displayName: 'Hello Kit',
    description: 'Say hello',
    developerName: 'Acme',
    format: 'portable',
    logo: null,
    scope: 'user',
    version: '1.0.0',
    digest: 'a'.repeat(64),
    source: { kind: 'local', label: 'hello-kit' },
    signature: { status: 'local_user_source', publisher: null },
    enabled: true,
    materialization: 'installed',
    activation: 'active',
    effective: true,
    toggleable: true,
    uninstallable: true,
    capabilities: {
      skills: 1,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
      commands: 0,
      apps: 0,
    },
    ...patch,
  } as PluginSummary
}

const GITHUB_LOGO = 'app://plugin-assets/managed/github/logo?v=abcd1234'

const PLUGINS = [
  plugin({}),
  plugin({
    pluginId: 'github',
    displayName: 'GitHub',
    description: '与 GitHub 集成',
    scope: 'managed',
    logo: GITHUB_LOGO,
  }),
  plugin({
    pluginId: 'computer-use',
    displayName: 'Computer Use',
    description: '让 Emperor 操作浏览器和 Mac 上的应用',
    scope: 'managed',
    enabled: false,
    activation: 'disabled',
  }),
  plugin({
    pluginId: 'acme/tools',
    displayName: 'Acme Tools',
    description: 'Tools from Acme',
  }),
]

function skill(name: string, title: string): SlashPaletteItem {
  return {
    id: `command:skill.user.${name}`,
    commandId: `skill.user.${name}`,
    kind: 'skill',
    name: `/${name}`,
    title,
    completion: `/${name}`,
    description: `${title} skill`,
    category: 'Skills',
    source: 'user_skill',
    sourceLabel: 'Personal',
    available: true,
    skillName: name,
  }
}

function mount(props: Record<string, unknown> = {}) {
  const onSend = vi.fn<(payload: ChatSendPayload) => void>()
  const onOpenPlugin = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(Composer, {
    busy: false,
    commands: [skill('image-gen', 'Image Gen')],
    plugins: PLUGINS,
    tools: [],
    contextUsed: 0,
    contextMax: 0,
    modelEntries: [],
    providerOptions: [],
    onSend,
    onOpenPlugin,
    ...props,
  })
  app.mount(container)
  return { root: container, onSend, onOpenPlugin }
}

function items(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('.capability-picker-item')].map(
    (item) => ({
      label: item.querySelector('strong')?.textContent ?? '',
      greyed: item.hasAttribute('data-unavailable'),
      meta: item.querySelector('b')?.textContent ?? '',
    }),
  )
}

function pick(root: HTMLElement, label: string): void {
  const button = [
    ...root.querySelectorAll<HTMLButtonElement>('.capability-picker-item'),
  ].find((item) => item.querySelector('strong')?.textContent === label)
  if (!button) throw new Error(`no palette item ${label}`)
  button.click()
}

describe('plugin references in the composer', () => {
  it('lists only plugins for @, usable first, and sends the chip as @id', async () => {
    const { root, onSend } = mount()
    const view = composerView(root)
    typeInto(view, '看看 @')
    await nextTick()
    expect(
      root.querySelector('.capability-picker')?.getAttribute('data-mode'),
    ).toBe('mention')
    expect(items(root)).toEqual([
      { label: 'Acme Tools', greyed: false, meta: '@acme/tools' },
      { label: 'GitHub', greyed: false, meta: '@github' },
      { label: 'Hello Kit', greyed: false, meta: '@hello-kit' },
      { label: 'Computer Use', greyed: true, meta: '电脑操作未开启' },
    ])
    typeInto(view, 'git')
    await nextTick()
    expect(items(root).map((item) => item.label)).toEqual(['GitHub'])
    pressKey(view, 'Enter')
    await nextTick()
    typeInto(view, '的 PR')
    expect(visibleText(view)).toBe('看看 GitHub 的 PR')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend).toHaveBeenCalledWith({
      content: '看看 @github 的 PR',
      displayContent: '看看 @github 的 PR',
      attachments: [],
      requestedSkills: [],
      references: [
        { kind: 'plugin', id: 'github', label: 'GitHub', start: 3, end: 10 },
      ],
    })
  })

  it('lists plugins for @ at the start too, and keeps namespaced ids open', async () => {
    const { root, onSend } = mount()
    const view = composerView(root)
    typeInto(view, '@acme/to')
    await nextTick()
    expect(items(root).map((item) => item.label)).toEqual(['Acme Tools'])
    pick(root, 'Acme Tools')
    await nextTick()
    typeInto(view, '整理一下')
    pressKey(view, 'Enter')
    await nextTick()
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      content: '@acme/tools 整理一下',
      references: [{ kind: 'plugin', id: 'acme/tools', start: 0, end: 11 }],
    })
  })

  it('opens the detail of a plugin that cannot be used, inserting nothing', async () => {
    const { root, onOpenPlugin } = mount()
    const view = composerView(root)
    typeInto(view, '用 @comp')
    await nextTick()
    pick(root, 'Computer Use')
    await nextTick()
    expect(onOpenPlugin).toHaveBeenCalledWith({
      pluginId: 'computer-use',
      scope: 'managed',
    })
    expect(root.querySelector('.composer-chip')).toBeNull()
    expect(root.querySelector('.capability-picker')).toBeNull()
  })

  it('turns a typed usable @id into a chip and leaves the rest as text', async () => {
    const { root } = mount()
    const view = composerView(root)
    typeInto(view, '@github ')
    typeInto(view, '@computer-use ')
    typeInto(view, '@nope ')
    await nextTick()
    const chips = [...root.querySelectorAll<HTMLElement>('.composer-chip')].map(
      (chip) => [chip.dataset.kind, chip.dataset.id],
    )
    expect(chips).toEqual([['plugin', 'github']])
    expect(visibleText(view)).toBe('GitHub @computer-use @nope ')
  })

  it('shows the logo on a plugin chip, or the fallback, and reads it as a plugin', async () => {
    const { root } = mount()
    const view = composerView(root)
    typeInto(view, '@github ')
    typeInto(view, '@hello-kit ')
    await nextTick()
    const [github, hello] = [
      ...root.querySelectorAll<HTMLElement>(
        '.composer-chip[data-kind="plugin"]',
      ),
    ]
    expect(github!.getAttribute('aria-label')).toBe('插件 GitHub')
    expect(github!.querySelector('img')?.getAttribute('src')).toBe(GITHUB_LOGO)
    expect(hello!.querySelector('img')).toBeNull()
    expect(hello!.querySelector('[data-chip-fallback]')).not.toBeNull()
  })

  it('offers plugins in the + menu', async () => {
    const { root } = mount()
    const view = composerView(root)
    typeInto(view, '先 ')
    root
      .querySelector<HTMLButtonElement>('button[aria-label="添加附件与能力"]')!
      .click()
    await nextTick()
    const insert = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes('插入 Skill 或插件'))
    insert!.click()
    await nextTick()
    const labels = [
      ...root.querySelectorAll<HTMLElement>('.composer-palette-label'),
    ].map((label) => label.textContent)
    expect(labels).toContain('插件')
    pick(root, 'GitHub')
    await nextTick()
    expect(visibleText(view)).toBe('先 GitHub ')
  })
})
