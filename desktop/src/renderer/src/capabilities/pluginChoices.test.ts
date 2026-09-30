import { describe, expect, it } from 'vitest'
import type { PluginSummary } from '../types'
import {
  pluginCatalog,
  pluginChipItem,
  pluginChoices,
  pluginDetailLocation,
  rankPluginChoices,
} from './pluginChoices'

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

const LIST = [
  plugin({}),
  // Shadowed by the user copy above: only the row in effect counts.
  plugin({ scope: 'managed', effective: false, displayName: 'Old Hello' }),
  plugin({
    pluginId: 'github',
    displayName: 'GitHub',
    description: '与 GitHub 集成',
    scope: 'managed',
    logo: 'app://plugin-assets/managed/github/logo?v=1',
  }),
  plugin({
    pluginId: 'computer-use',
    displayName: 'Computer Use',
    description: '让 Emperor 操作浏览器',
    scope: 'managed',
    enabled: false,
    activation: 'disabled',
  }),
  plugin({
    pluginId: 'acme/web',
    displayName: 'Web Kit',
    description: 'Browse the web',
    activation: 'blocked_unverified',
  }),
  plugin({
    pluginId: 'gone-kit',
    displayName: 'Gone',
    description: 'Removed files',
    activation: 'missing',
  }),
]

describe('plugin choices for @ references', () => {
  it('offers one choice per plugin, the row in effect, saying why others cannot be used', () => {
    expect(
      pluginChoices(LIST).map(({ id, label, scope, unavailable }) => [
        id,
        label,
        scope,
        unavailable,
      ]),
    ).toEqual([
      ['hello-kit', 'Hello Kit', 'user', null],
      ['github', 'GitHub', 'managed', null],
      ['computer-use', 'Computer Use', 'managed', '电脑操作未开启'],
      ['acme/web', 'Web Kit', 'user', '来源未验证'],
      ['gone-kit', 'Gone', 'user', '插件内容缺失'],
    ])
    expect(
      pluginChoices([plugin({ activation: 'disabled', enabled: false })])[0]!
        .unavailable,
    ).toBe('已停用')
  })

  it('ranks usable plugins first, matching id, name or description', () => {
    const choices = pluginChoices(LIST)
    expect(rankPluginChoices(choices, '').map((choice) => choice.id)).toEqual([
      'github',
      'hello-kit',
      'computer-use',
      'gone-kit',
      'acme/web',
    ])
    expect(
      rankPluginChoices(choices, 'git').map((choice) => choice.id),
    ).toEqual(['github'])
    expect(
      rankPluginChoices(choices, 'HELLO').map((choice) => choice.id),
    ).toEqual(['hello-kit'])
    expect(
      rankPluginChoices(choices, '集成').map((choice) => choice.id),
    ).toEqual(['github'])
    expect(
      rankPluginChoices(choices, 'acme/').map((choice) => choice.id),
    ).toEqual(['acme/web'])
  })

  it('knows only usable plugins as chips, with their logo', () => {
    const catalog = pluginCatalog(pluginChoices(LIST))
    expect(catalog.label('github')).toBe('GitHub')
    expect(catalog.logo('github')).toBe(
      'app://plugin-assets/managed/github/logo?v=1',
    )
    expect(catalog.label('computer-use')).toBeUndefined()
    expect(catalog.label('nope')).toBeUndefined()
    expect(catalog.logo('hello-kit')).toBeNull()
  })

  it('inserts a chip for a usable plugin and opens the detail of any other', () => {
    const [hello, , computerUse] = pluginChoices(LIST)
    expect(pluginChipItem(hello!)).toMatchObject({
      action: 'insert_reference',
      label: 'Hello Kit',
      meta: '@hello-kit',
      reference: { kind: 'plugin', id: 'hello-kit', label: 'Hello Kit' },
      logo: { name: 'Hello Kit', url: null },
    })
    expect(pluginChipItem(hello!).disabled).toBeFalsy()
    expect(pluginChipItem(computerUse!)).toMatchObject({
      action: 'open_plugin',
      disabled: true,
      meta: '电脑操作未开启',
      plugin: { pluginId: 'computer-use', scope: 'managed' },
    })
    expect(
      pluginDetailLocation({ pluginId: 'acme/web', scope: 'user' }),
    ).toEqual({
      path: '/capabilities',
      query: { plugin: 'acme/web', scope: 'user' },
    })
  })
})
