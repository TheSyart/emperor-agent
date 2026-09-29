import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeCoreOperation } from './operations'
import { makeApi, tmp, type ApiFixture } from './test-helpers'
import {
  MCP_SCHEMA_URL,
  portablePackage,
  skillMarkdown,
  STDIO_MCP_SERVER,
  writePackage,
  type PackageFiles,
} from '../plugins/testing'

let fixture: ApiFixture | null = null

afterEach(async () => {
  await fixture?.api.close()
  fixture = null
})

async function installKit(api: ApiFixture['api']) {
  const source = writePackage(
    join(tmp('emperor-plugin-api-'), 'hello-kit'),
    portablePackage('hello-kit', {
      'skills/hello/SKILL.md': skillMarkdown('hello', 'Say hello'),
      'skills/wave/SKILL.md': skillMarkdown('wave', 'Wave'),
    }),
  )
  const preview = await api.plugins.inspect({ kind: 'local', path: source })
  return api.plugins.install({
    previewId: preview.previewId,
    digest: preview.digest,
    scope: 'user',
  })
}

describe('plugins through CoreApi', () => {
  it('serves the detail, feeds the Skill catalog and announces changes', async () => {
    fixture = await makeApi()
    const { api, events } = fixture
    await installKit(api)

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    const names = () => api.skills.list().skills.map((skill) => skill.name)
    expect(names()).toEqual(expect.arrayContaining(['hello', 'wave']))
    const detail = await invokeCoreOperation(api, 'plugins.getDetail', [
      { pluginId: 'hello-kit', scope: 'user' },
    ])
    expect(detail).toMatchObject({
      pluginId: 'hello-kit',
      format: 'portable',
      activation: 'active',
      components: [
        { kind: 'skill', id: 'hello', state: 'available' },
        { kind: 'skill', id: 'wave', state: 'available' },
      ],
    })

    events.length = 0
    api.plugins.setEnabled({
      pluginId: 'hello-kit',
      scope: 'user',
      enabled: false,
    })
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'plugins_changed', reason: 'plugins' }),
    )
    expect(names()).not.toContain('hello')
  })

  it('marks a plugin Skill that a personal Skill of the same name overrides', async () => {
    fixture = await makeApi()
    const { api, stateRoot } = fixture
    mkdirSync(join(stateRoot, 'skills', 'hello'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'skills', 'hello', 'SKILL.md'),
      skillMarkdown('hello', 'Mine'),
    )
    await installKit(api)
    expect(
      api.plugins
        .getDetail({ pluginId: 'hello-kit', scope: 'user' })
        .components.map(({ id, state, reason }) => [id, state, reason]),
    ).toEqual([
      ['hello', 'failed', '与个人的同名 Skill 冲突，未生效'],
      ['wave', 'available', null],
    ])
  })

  it('rejects an unknown plugin with a stable code', async () => {
    fixture = await makeApi()
    expect(() =>
      fixture!.api.plugins.getDetail({ pluginId: 'nobody', scope: 'user' }),
    ).toThrow(expect.objectContaining({ code: 'plugin_not_found' }))
  })
})

const WHERE_KIT: PackageFiles = portablePackage('where-kit', {
  'server.js': STDIO_MCP_SERVER,
  'mcp.json': {
    $schema: MCP_SCHEMA_URL,
    mcpServers: {
      where: {
        type: 'stdio',
        command: process.execPath,
        args: ['${PLUGIN_ROOT}/server.js'],
      },
    },
  },
  'hooks/hooks.json': {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'echo "$PLUGIN_ROOT" >> "$PLUGIN_DATA/hook.log"',
            },
          ],
        },
      ],
    },
  },
})

const TOOL = 'mcp_where-kit-where_where'

function bashTurn(id: string) {
  return [
    {
      tools: [
        {
          id,
          name: 'bash',
          args: { command: `echo ${id}`, description: 'Print a word' },
        },
      ],
    },
    { text: 'done' },
  ]
}

describe('plugin MCP servers and hooks through CoreApi', () => {
  it('runs them for real, stops them when disabled, and never touches user files', async () => {
    fixture = await makeApi({ replies: [...bashTurn('b1'), ...bashTurn('b2')] })
    const { api, stateRoot } = fixture
    const userMcp = join(stateRoot, 'mcp_config.json')
    const userHooks = join(stateRoot, 'hooks.json')
    writeFileSync(userMcp, JSON.stringify({ servers: {} }))
    writeFileSync(userHooks, JSON.stringify({ hooks: {} }))
    const before = [
      readFileSync(userMcp, 'utf8'),
      readFileSync(userHooks, 'utf8'),
    ]

    const source = writePackage(
      join(tmp('emperor-plugin-api-'), 'where-kit'),
      WHERE_KIT,
    )
    const preview = await api.plugins.inspect({ kind: 'local', path: source })
    await api.plugins.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })

    // MCP: a real stdio server, started in the package with its variables.
    expect(api.host.tools.names()).toContain(TOOL)
    const adapter = api.host.kept.mcpClient
      .getTools()
      .find((tool) => tool.name === TOOL)!
    const where = JSON.parse(
      (await adapter.execute({ note: 'one' })).rawContent,
    ) as {
      cwd: string
      root: string
    }
    expect(api.skills.tools().find((tool) => tool.name === TOOL)).toMatchObject(
      {
        source: 'mcp',
        server: 'where-kit-where',
        plugin_id: 'where-kit',
      },
    )
    const packageRoot = realpathSync(where.root)
    expect(
      packageRoot.startsWith(realpathSync(join(stateRoot, 'plugins', 'cache'))),
    ).toBe(true)
    expect(realpathSync(where.cwd)).toBe(packageRoot)
    const data = join(stateRoot, 'plugins', 'data', 'where-kit')
    expect(readFileSync(join(data, 'calls.log'), 'utf8')).toBe('one\n')
    expect(
      api.plugins
        .getDetail({ pluginId: 'where-kit', scope: 'user' })
        .components.map(({ kind, state }) => [kind, state]),
    ).toEqual([
      ['mcp', 'running'],
      ['hook', 'available'],
    ])

    // Hook: runs on a real bash call with this plugin's variables.
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    await api.chat.submit({ content: 'run', sessionId })
    expect(readFileSync(join(data, 'hook.log'), 'utf8')).toBe(`${where.root}\n`)

    // Disabled: the tool and the hook are gone, and nothing new happens.
    await api.plugins.setEnabled({
      pluginId: 'where-kit',
      scope: 'user',
      enabled: false,
    })
    expect(api.host.tools.names()).not.toContain(TOOL)
    expect(
      api.host.kept.mcpClient.pluginServerSnapshot('where-kit-where'),
    ).toBeNull()
    expect(api.host.hooks.describe().plugins).toEqual([])
    await api.chat.submit({ content: 'again', sessionId })
    expect(readFileSync(join(data, 'hook.log'), 'utf8')).toBe(`${where.root}\n`)
    expect(readFileSync(join(data, 'calls.log'), 'utf8')).toBe('one\n')

    // Enabled again: registered exactly once.
    await api.plugins.setEnabled({
      pluginId: 'where-kit',
      scope: 'user',
      enabled: true,
    })
    expect(api.host.tools.names().filter((name) => name === TOOL)).toHaveLength(
      1,
    )
    expect(api.host.hooks.describe().plugins).toEqual(['where-kit@user'])

    expect([
      readFileSync(userMcp, 'utf8'),
      readFileSync(userHooks, 'utf8'),
    ]).toEqual(before)
  })

  it('never runs members of an unverified URL package', async () => {
    const archive = writePackage(
      join(tmp('emperor-plugin-url-'), 'where-kit'),
      WHERE_KIT,
    )
    const zipped = zipDirectory(archive)
    fixture = await makeApi({
      extra: {
        webFetchClient: {
          get: async () => ({
            kind: 'response' as const,
            status: 200,
            url: 'https://plugins.example/where-kit.zip',
            headers: {},
            body: zipped,
          }),
        },
      },
    })
    const { api } = fixture
    const preview = await api.plugins.inspect({
      kind: 'url',
      url: 'https://plugins.example/where-kit.zip',
    })
    await api.plugins.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(api.plugins.list()[0]).toMatchObject({
      activation: 'blocked_unverified',
    })
    expect(api.host.tools.names()).not.toContain(TOOL)
    expect(api.host.hooks.describe().plugins).toEqual([])
  })
})

/** A stored (uncompressed) ZIP of every file under `root`. */
function zipDirectory(root: string): Buffer {
  const files: Array<{ name: string; data: Buffer }> = []
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(path, name)
      else files.push({ name: `where-kit/${name}`, data: readFileSync(path) })
    }
  }
  visit(root, '')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.byteLength, 18)
    local.writeUInt32LE(file.data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    locals.push(local, name, file.data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.data.byteLength, 20)
    central.writeUInt32LE(file.data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + file.data.byteLength
  }
  const size = centrals.reduce((total, part) => total + part.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
