import { describe, expect, it } from 'vitest'
import {
  componentStateBadge,
  filterPlugins,
  groupPlugins,
  memberGroups,
  pluginFacts,
  pluginKey,
  pluginMonogram,
  pluginSourceTag,
  pluginToolGroups,
} from './pluginsModel'
import type { PluginDetail, PluginSummary } from './pluginInstall'

function summary(patch: Partial<PluginSummary> = {}): PluginSummary {
  return {
    pluginId: 'hello-kit',
    name: 'Hello Kit',
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
  }
}

function detail(patch: Partial<PluginDetail> = {}): PluginDetail {
  return {
    pluginId: 'hello-kit',
    scope: 'user',
    format: 'portable',
    version: '1.0.0',
    displayName: 'Hello Kit',
    description: 'Say hello',
    longDescription: null,
    developerName: 'Acme',
    category: null,
    homepage: null,
    license: null,
    logo: null,
    logoIssue: null,
    prompts: [],
    enabled: true,
    effective: true,
    activation: 'active',
    materialization: 'installed',
    toggleable: true,
    uninstallable: true,
    source: { kind: 'local', label: 'hello-kit' },
    signature: { status: 'local_user_source', publisher: null },
    digest: 'a'.repeat(64),
    installedAt: '2026-09-30T08:00:00.000Z',
    permissions: { runsCommands: false, network: false },
    components: [],
    tools: { note: null, groups: [] },
    ...patch,
  }
}

function tool(name: string, readOnly = false) {
  return {
    name,
    description: `${name} does one thing.`,
    parameters: { type: 'object' },
    readOnly,
  }
}

describe('plugin list model', () => {
  it('separates what the user installed from what ships with Emperor', () => {
    const managed = summary({
      pluginId: 'github',
      displayName: 'GitHub',
      scope: 'managed',
    })
    const mine = summary()
    expect(groupPlugins([managed, mine])).toEqual({
      installed: [mine],
      preinstalled: [managed],
    })
    expect(pluginKey(managed)).toBe('github\u0000managed')
  })

  it('searches names, ids, descriptions and developers', () => {
    const list = [
      summary(),
      summary({
        pluginId: 'github',
        displayName: 'GitHub',
        description: '与 GitHub 集成',
        developerName: 'Emperor Agent',
      }),
    ]
    expect(filterPlugins(list, '').map((item) => item.pluginId)).toEqual([
      'hello-kit',
      'github',
    ])
    expect(filterPlugins(list, 'git').map((item) => item.pluginId)).toEqual([
      'github',
    ])
    expect(filterPlugins(list, '集成').map((item) => item.pluginId)).toEqual([
      'github',
    ])
    expect(filterPlugins(list, 'acme').map((item) => item.pluginId)).toEqual([
      'hello-kit',
    ])
  })

  it('tags the source', () => {
    expect(pluginSourceTag(summary({ source: { kind: 'managed' } }))).toBe(
      '随 Emperor 提供',
    )
    expect(pluginSourceTag(summary())).toBe('本地')
    expect(
      pluginSourceTag(
        summary({ source: { kind: 'url', url: 'https://x.example/a.zip' } }),
      ),
    ).toBe('网址')
  })

  it('draws a stable monogram for plugins without a logo', () => {
    expect(pluginMonogram('Computer Use')).toEqual({
      letter: 'C',
      tone: pluginMonogram('Computer Use').tone,
    })
    expect(pluginMonogram('Computer Use')).toEqual(
      pluginMonogram('Computer Use'),
    )
    expect(pluginMonogram('github').letter).toBe('G')
    expect(pluginMonogram('中文插件').letter).toBe('中')
  })
})

describe('plugin detail model', () => {
  it('groups real members by kind and hides empty groups', () => {
    const groups = memberGroups(
      detail({
        components: [
          {
            kind: 'skill',
            id: 'hello',
            title: 'hello',
            description: 'Say hello',
            state: 'available',
            reason: null,
          },
          {
            kind: 'mcp',
            id: 'search',
            title: 'search',
            description: 'http · search.example',
            state: 'failed',
            reason: 'MCP server connection failed',
          },
          {
            kind: 'hook',
            id: 'Stop#1',
            title: 'Stop',
            description: 'stop.sh',
            state: 'available',
            reason: null,
          },
          {
            kind: 'agent',
            id: 'agents/a.md',
            title: 'a',
            description: '',
            state: 'unsupported',
            reason: 'Emperor 不支持插件里的子代理',
          },
          {
            kind: 'command',
            id: 'commands/b.md',
            title: 'b',
            description: '',
            state: 'unsupported',
            reason: 'Emperor 不支持插件里的命令',
          },
        ],
      }),
    )
    expect(
      groups.map((group) => [group.key, group.title, group.items.length]),
    ).toEqual([
      ['skill', 'Skills', 1],
      ['mcp', 'MCP', 1],
      ['hook', 'Hooks', 1],
      ['unsupported', '不支持的成员', 2],
    ])
    expect(memberGroups(detail())).toEqual([])
  })

  it('labels member states with tones', () => {
    expect(componentStateBadge('available')).toEqual({
      label: '可用',
      tone: 'ok',
    })
    expect(componentStateBadge('running')).toEqual({
      label: '运行中',
      tone: 'ok',
    })
    expect(componentStateBadge('starting')).toEqual({
      label: '连接中',
      tone: 'neutral',
    })
    expect(componentStateBadge('needs_connection')).toEqual({
      label: '需要连接',
      tone: 'warn',
    })
    expect(componentStateBadge('disabled')).toEqual({
      label: '已停用',
      tone: 'neutral',
    })
    expect(componentStateBadge('unsupported')).toEqual({
      label: '不支持',
      tone: 'neutral',
    })
    expect(componentStateBadge('failed')).toEqual({
      label: '失败',
      tone: 'error',
    })
  })

  it('lists the facts of the info group', () => {
    const items = pluginFacts(
      detail({
        category: '开发',
        homepage: 'https://acme.example',
        license: 'MIT',
        permissions: { runsCommands: true, network: true },
      }),
    )
    expect(items.map((item) => [item.term, item.value])).toEqual([
      ['来源', '本地 · hello-kit'],
      ['范围', '用户'],
      ['格式', '可移植插件'],
      ['版本', '1.0.0'],
      ['权限', '会运行本机命令，会联网'],
      ['类别', '开发'],
      ['主页', 'https://acme.example'],
      ['许可证', 'MIT'],
      ['安装时间', expect.stringMatching(/2026/)],
      ['Digest', 'aaaaaaaaaaaaaaaa…'],
    ])
    const managed = pluginFacts(
      detail({
        scope: 'managed',
        source: { kind: 'managed' },
        format: 'portable',
        version: null,
        installedAt: null,
        digest: null,
      }),
    )
    expect(managed.map((item) => [item.term, item.value])).toEqual([
      ['来源', '随 Emperor 提供'],
      ['范围', '受管'],
      ['格式', '可移植插件'],
      ['版本', '未提供'],
      ['权限', '无'],
    ])
  })

  it('lists Computer Use’s tools by driver, each driver with its settings page', () => {
    const groups = pluginToolGroups(
      detail({
        pluginId: 'computer-use',
        scope: 'managed',
        tools: {
          note: '打开电脑操作后可用',
          groups: [
            {
              id: 'ui',
              kind: 'computer-use',
              title: '通用',
              note: null,
              tools: [tool('ui_list_targets', true)],
            },
            {
              id: 'embedded-browser',
              kind: 'computer-use',
              title: '内置浏览器',
              note: null,
              tools: [tool('browser_open')],
            },
            {
              id: 'external-browser',
              kind: 'computer-use',
              title: 'Chrome 和 Edge',
              note: null,
              tools: [tool('external_tab_list', true)],
            },
            {
              id: 'desktop',
              kind: 'computer-use',
              title: 'Mac 应用',
              note: null,
              tools: [tool('desktop_click')],
            },
          ],
        },
      }),
    )
    expect(
      groups.map((group) => [group.id, group.title, group.settings]),
    ).toEqual([
      ['ui', '通用', null],
      [
        'embedded-browser',
        '内置浏览器',
        { section: 'browser', page: null, label: '设置 › 浏览器' },
      ],
      [
        'external-browser',
        'Chrome 和 Edge',
        {
          section: 'computer',
          page: 'chrome',
          label: '设置 › 电脑操作 › Chrome 和 Edge',
        },
      ],
      [
        'desktop',
        'Mac 应用',
        {
          section: 'computer',
          page: 'apps',
          label: '设置 › 电脑操作 › 任意应用',
        },
      ],
    ])
    // The rows are tool rows, as 能力 › 工具 draws them.
    expect(groups[0]!.tools).toEqual([
      {
        name: 'ui_list_targets',
        description: 'ui_list_targets does one thing.',
        parameters: { type: 'object' },
        read_only: true,
        source: 'builtin',
        plugin_id: 'computer-use',
      },
    ])
  })

  it('lists a plugin’s MCP tools by member, with no settings page', () => {
    const groups = pluginToolGroups(
      detail({
        tools: {
          note: null,
          groups: [
            {
              id: 'search',
              kind: 'mcp',
              title: 'search',
              note: null,
              tools: [tool('mcp_hello-kit-search_find', true)],
            },
            {
              id: 'docs',
              kind: 'mcp',
              title: 'docs',
              note: '服务器没有运行',
              tools: [],
            },
          ],
        },
      }),
    )
    expect(
      groups.map((group) => [
        group.id,
        group.note,
        group.settings,
        group.tools.map((item) => [item.name, item.source, item.plugin_id]),
      ]),
    ).toEqual([
      [
        'search',
        null,
        null,
        [['mcp_hello-kit-search_find', 'mcp', 'hello-kit']],
      ],
      ['docs', '服务器没有运行', null, []],
    ])
  })
})
