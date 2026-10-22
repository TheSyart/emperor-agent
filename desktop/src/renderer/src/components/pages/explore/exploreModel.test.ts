import { describe, expect, it } from 'vitest'
import {
  exploreCatalogIssues,
  exploreEntryInstalled,
  exploreEntryIssues,
  isPrivateHost,
  mcpEntryConfigText,
  mcpEntryServerNames,
  publicHttpsIssue,
  skillNameFromUrl,
  validExploreEntries,
  type ExploreEntry,
} from './exploreModel'

function skill(overrides: Partial<ExploreEntry> = {}): ExploreEntry {
  return {
    id: 'acme-writer',
    kind: 'skill',
    name: 'Writer',
    publisher: 'Acme',
    description: '写作助手',
    homepage: 'https://github.com/acme/skills',
    tags: ['写作'],
    install: {
      skillUrl: 'https://github.com/acme/skills/tree/main/skills/writer',
    },
    ...overrides,
  }
}

function mcp(
  servers: Record<string, unknown>,
  overrides: Partial<ExploreEntry> = {},
): ExploreEntry {
  return {
    id: 'acme-mcp',
    kind: 'mcp',
    name: 'Acme MCP',
    publisher: 'Acme',
    description: '工具',
    homepage: 'https://acme.dev/mcp',
    tags: [],
    install: { mcpConfig: { mcpServers: servers } },
    ...overrides,
  }
}

describe('explore URL policy', () => {
  it('flags loopback, private and local hosts', () => {
    for (const host of [
      'localhost',
      'api.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      'printer.local',
      'svc.internal',
    ])
      expect(isPrivateHost(host), host).toBe(true)
    for (const host of ['github.com', 'mcp.deepwiki.com', '172.32.0.1'])
      expect(isPrivateHost(host), host).toBe(false)
  })

  it('accepts only public https URLs without credentials', () => {
    expect(publicHttpsIssue('https://github.com/a/b')).toBe('')
    expect(publicHttpsIssue('http://github.com/a/b')).toMatch(/not https/)
    expect(publicHttpsIssue('https://user:pw@github.com/a')).toMatch(
      /credentials/,
    )
    expect(publicHttpsIssue('https://token@github.com/a')).toMatch(
      /credentials/,
    )
    expect(publicHttpsIssue('https://127.0.0.1:8080/mcp')).toMatch(/private/)
    expect(publicHttpsIssue('file:///etc/passwd')).toMatch(/not https/)
    expect(publicHttpsIssue('not a url')).toMatch(/invalid/)
    expect(publicHttpsIssue('')).toMatch(/missing/)
  })
})

describe('explore entry validation', () => {
  it('accepts well-formed skill, mcp and plugin entries', () => {
    expect(exploreEntryIssues(skill())).toEqual([])
    expect(
      exploreEntryIssues(
        mcp({ tools: { command: 'npx', args: ['-y', '@acme/mcp'] } }),
      ),
    ).toEqual([])
    expect(
      exploreEntryIssues(
        mcp({ remote: { type: 'http', url: 'https://mcp.acme.dev/mcp' } }),
      ),
    ).toEqual([])
    expect(
      exploreEntryIssues(
        skill({
          id: 'acme-kit',
          kind: 'plugin',
          install: { pluginUrl: 'https://acme.dev/kit.zip' },
        }),
      ),
    ).toEqual([])
  })

  it('rejects mismatched installs, unknown kinds and bad ids', () => {
    expect(
      exploreEntryIssues(
        skill({ install: { pluginUrl: 'https://acme.dev/kit.zip' } }),
      ),
    ).toEqual(['acme-writer: install must be { skillUrl }'])
    expect(
      exploreEntryIssues(skill({ kind: 'theme' as never })).join(),
    ).toMatch(/unknown kind/)
    expect(exploreEntryIssues(skill({ id: 'Bad Id' })).join()).toMatch(
      /kebab-case/,
    )
    expect(
      exploreEntryIssues(
        skill({ install: { skillUrl: 'http://github.com/a/b' } }),
      ).join(),
    ).toMatch(/not https/)
    expect(exploreEntryIssues(skill({ homepage: '' })).join()).toMatch(
      /homepage/,
    )
  })

  it('rejects MCP configs with secrets, shells or private URLs', () => {
    const issues = (servers: Record<string, unknown>) =>
      exploreEntryIssues(mcp(servers)).join('\n')
    expect(issues({})).toMatch(/no mcpServers/)
    expect(
      issues({ a: { command: 'npx', args: ['x'], env: { TOKEN: 'secret' } } }),
    ).toMatch(/unsupported field env/)
    expect(
      issues({ a: { type: 'http', url: 'https://x.dev', headers: {} } }),
    ).toMatch(/unsupported field headers/)
    expect(issues({ a: { command: 'bash', args: ['-c', 'x'] } })).toMatch(
      /runs bash/,
    )
    expect(issues({ a: { command: 'npx' } })).toMatch(/string args/)
    expect(issues({ a: { type: 'http', url: 'http://x.dev/mcp' } })).toMatch(
      /not https/,
    )
    expect(
      issues({ a: { type: 'http', url: 'https://localhost:3000/mcp' } }),
    ).toMatch(/private host/)
    expect(issues({ a: { type: 'ws', url: 'https://x.dev' } })).toMatch(
      /unknown type/,
    )
    expect(issues({ 'bad name': { command: 'npx', args: ['x'] } })).toMatch(
      /bad server name/,
    )
  })

  it('checks the catalog envelope and drops invalid or duplicate entries', () => {
    expect(exploreCatalogIssues({ version: 2, entries: [] })).toEqual([
      'catalog version must be 1',
    ])
    expect(exploreCatalogIssues([])).toEqual(['catalog must be an object'])
    const catalog = {
      version: 1,
      entries: [skill(), skill(), skill({ id: 'x y' })],
    }
    expect(exploreCatalogIssues(catalog).join('\n')).toMatch(
      /acme-writer: duplicate id/,
    )
    expect(validExploreEntries(catalog).map((entry) => entry.id)).toEqual([
      'acme-writer',
    ])
    expect(validExploreEntries({ version: 2, entries: [skill()] })).toEqual([])
  })
})

describe('explore list helpers', () => {
  const entries = [
    skill(),
    mcp(
      { tools: { command: 'npx', args: ['-y', '@acme/mcp'] } },
      { id: 'acme-tools', name: 'Tools', tags: ['需要 Node.js'] },
    ),
    skill({
      id: 'acme-kit',
      kind: 'plugin',
      name: 'Kit',
      publisher: 'Other',
      install: { pluginUrl: 'https://acme.dev/kit.zip' },
    }),
  ]

  it('knows what is installed already', () => {
    const [writer, tools, kit] = entries as [
      ExploreEntry,
      ExploreEntry,
      ExploreEntry,
    ]
    expect(
      skillNameFromUrl(
        'https://github.com/acme/skills/tree/main/skills/writer',
      ),
    ).toBe('writer')
    expect(skillNameFromUrl('nope')).toBe('')
    expect(mcpEntryServerNames(tools)).toEqual(['tools'])
    expect(mcpEntryServerNames(writer)).toEqual([])
    const state = { skills: ['writer'], mcpServers: ['github'] }
    expect(exploreEntryInstalled(writer, state)).toBe(true)
    expect(exploreEntryInstalled(tools, state)).toBe(false)
    expect(
      exploreEntryInstalled(tools, { skills: [], mcpServers: ['tools'] }),
    ).toBe(true)
    expect(exploreEntryInstalled(kit, state)).toBe(false)
  })

  it('pretty-prints the MCP config for the add dialog', () => {
    const [, tools] = entries as [ExploreEntry, ExploreEntry]
    const text = mcpEntryConfigText(tools)
    expect(JSON.parse(text)).toEqual({
      mcpServers: { tools: { command: 'npx', args: ['-y', '@acme/mcp'] } },
    })
    expect(text.endsWith('\n')).toBe(true)
    expect(mcpEntryConfigText(skill())).toBe('')
  })
})

describe('recommendedEntries (UI-S08)', () => {
  const entry = (id: string, kind: 'skill' | 'mcp' | 'plugin') =>
    ({ id, kind }) as unknown as import('./exploreModel').ExploreEntry
  const all = [
    entry('s1', 'skill'),
    entry('m1', 'mcp'),
    entry('s2', 'skill'),
    entry('m2', 'mcp'),
    entry('s3', 'skill'),
    entry('m3', 'mcp'),
    entry('s4', 'skill'),
    entry('p1', 'plugin'),
  ]

  it('shows up to six on 插件, and only its kind on Skills and MCP', async () => {
    const { recommendedEntries } = await import('./exploreModel')
    expect(recommendedEntries(all, 'plugins').map((e) => e.id)).toEqual([
      's1',
      'm1',
      's2',
      'm2',
      's3',
      'm3',
    ])
    expect(recommendedEntries(all, 'skills').map((e) => e.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
    ])
    expect(recommendedEntries(all, 'mcp').map((e) => e.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
    expect(recommendedEntries(all, 'tools')).toEqual([])
  })

  it('shows nothing when fewer than three would fit a tab', async () => {
    const { recommendedEntries } = await import('./exploreModel')
    expect(
      recommendedEntries([entry('m1', 'mcp'), entry('m2', 'mcp')], 'mcp'),
    ).toEqual([])
  })
})
