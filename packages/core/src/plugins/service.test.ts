import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginApplicationService } from './service'

function fixture(version = '1.0.0') {
  const emperorHome = mkdtempSync(join(tmpdir(), 'emperor-plugin-service-'))
  const pluginRoot = join(emperorHome, 'source-plugin')
  mkdirSync(join(pluginRoot, '.emperor-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'skills', 'agent-reach'), { recursive: true })
  writeFileSync(
    join(pluginRoot, '.emperor-plugin', 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'official/agent-reach',
      name: 'Agent Reach',
      version,
      skills: ['skills'],
    }),
  )
  writeFileSync(
    join(pluginRoot, 'skills', 'agent-reach', 'SKILL.md'),
    '---\nname: agent-reach\ndescription: Reach the web\n---\nUse it.\n',
  )
  return { emperorHome, pluginRoot }
}

describe('PluginApplicationService', () => {
  it('inspects, atomically installs, enables, disables, and uninstalls a Plugin', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const changed = vi.fn()
    const service = new PluginApplicationService({
      emperorHome,
      onChanged: changed,
    })
    const preview = await service.inspect({ kind: 'local', path: pluginRoot })

    expect(preview).toMatchObject({
      pluginId: 'official/agent-reach',
      version: '1.0.0',
      signature: { status: 'local_user_source' },
      capabilities: { skills: ['skills'] },
    })
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({
      pluginId: 'official/agent-reach',
      enabled: true,
      materialization: 'installed',
      activation: 'active',
    })
    expect(service.enabledSkillRoots()).toHaveLength(1)

    expect(
      service.setEnabled({
        pluginId: 'official/agent-reach',
        scope: 'user',
        enabled: false,
      }).plugin,
    ).toMatchObject({ enabled: false, materialization: 'installed' })
    expect(service.enabledSkillRoots()).toEqual([])

    const cachePath = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath
    expect(
      service.uninstall({ pluginId: 'official/agent-reach', scope: 'user' })
        .changed,
    ).toBe(true)
    expect(existsSync(cachePath)).toBe(true)
    expect(changed).toHaveBeenCalled()
  })

  it('binds confirmation to the preview digest and preserves the prior cache on update', async () => {
    const first = fixture('1.0.0')
    const service = new PluginApplicationService({
      emperorHome: first.emperorHome,
    })
    const preview = await service.inspect({
      kind: 'local',
      path: first.pluginRoot,
    })
    await expect(
      service.install({
        previewId: preview.previewId,
        digest: 'b'.repeat(64),
        scope: 'user',
      }),
    ).rejects.toThrow(/digest/i)
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const oldCache = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath

    const second = fixture('2.0.0')
    const next = await service.inspect({
      kind: 'local',
      path: second.pluginRoot,
    })
    await service.install({
      previewId: next.previewId,
      digest: next.digest,
      scope: 'user',
    })

    expect(service.store.get('official/agent-reach', 'user')?.version).toBe(
      '2.0.0',
    )
    expect(existsSync(oldCache)).toBe(true)
  })

  it('rejects manifest paths that escape the Plugin root', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const manifestPath = join(pluginRoot, '.emperor-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.skills = ['../outside']
    writeFileSync(manifestPath, JSON.stringify(manifest))

    await expect(
      new PluginApplicationService({ emperorHome }).inspect({
        kind: 'local',
        path: pluginRoot,
      }),
    ).rejects.toThrow(/containment|relative path/i)
  })

  it('keeps enabled intent distinct from missing materialization', () => {
    const { emperorHome } = fixture()
    const service = new PluginApplicationService({ emperorHome })
    const result = service.setEnabled({
      pluginId: 'official/missing',
      scope: 'user',
      enabled: true,
    })
    expect(result.plugin).toMatchObject({
      enabled: true,
      materialization: 'missing',
      activation: 'missing',
    })
  })

  it('reports a missing immutable cache without breaking Plugin inventory', async () => {
    const { emperorHome, pluginRoot } = fixture()
    const service = new PluginApplicationService({ emperorHome })
    const preview = await service.inspect({ kind: 'local', path: pluginRoot })
    await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    const cachePath = service.store.get(
      'official/agent-reach',
      'user',
    )!.installPath
    rmSync(cachePath, { recursive: true, force: true })

    expect(service.list()).toEqual([
      expect.objectContaining({
        pluginId: 'official/agent-reach',
        enabled: true,
        materialization: 'missing',
        activation: 'missing',
      }),
    ])
    expect(service.enabledSkillRoots()).toEqual([])
  })

  it('treats corrupt settings as no enablement intent during bootstrap', () => {
    const { emperorHome } = fixture()
    writeFileSync(join(emperorHome, 'settings.json'), '{not valid json', 'utf8')

    const service = new PluginApplicationService({ emperorHome })

    expect(service.list()).toEqual([])
    expect(readFileSync(join(emperorHome, 'settings.json'), 'utf8')).toBe(
      '{not valid json',
    )
  })

  it('uses the trusted host WebFetch client for remote Plugin archives', async () => {
    const { emperorHome } = fixture()
    const archive = zip([
      {
        name: 'agent-reach/.emperor-plugin/plugin.json',
        data: JSON.stringify({
          schemaVersion: 1,
          id: 'official/agent-reach',
          name: 'Agent Reach',
          version: '3.0.0',
          skills: ['skills'],
        }),
      },
      {
        name: 'agent-reach/skills/agent-reach/SKILL.md',
        data: '---\nname: agent-reach\ndescription: remote\n---\nRemote.\n',
      },
    ])
    const get = vi.fn(async () => ({
      kind: 'response' as const,
      status: 200,
      url: 'https://downloads.example/plugin.zip',
      headers: {},
      body: archive,
    }))
    const service = new PluginApplicationService({
      emperorHome,
      webFetchClient: { get },
    })

    const preview = await service.inspect({
      kind: 'url',
      url: 'https://downloads.example/plugin.zip',
    })

    expect(preview).toMatchObject({
      version: '3.0.0',
      signature: { status: 'unverified' },
    })
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ redirectMode: 'follow_validated' }),
    )
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({
      enabled: true,
      materialization: 'installed',
      activation: 'blocked_unverified',
      signature: { status: 'unverified' },
    })
    expect(service.enabledSkillRoots()).toEqual([])
  })

  it('installs a local .zip archive as a local user source', async () => {
    const { emperorHome } = fixture()
    const archivePath = join(emperorHome, 'agent-reach.zip')
    writeFileSync(
      archivePath,
      zip([
        {
          name: 'agent-reach/.emperor-plugin/plugin.json',
          data: JSON.stringify({
            schemaVersion: 1,
            id: 'official/agent-reach',
            name: 'Agent Reach',
            version: '4.0.0',
            skills: ['skills'],
          }),
        },
        {
          name: 'agent-reach/skills/agent-reach/SKILL.md',
          data: '---\nname: agent-reach\ndescription: zipped\n---\nZipped.\n',
        },
      ]),
    )
    const service = new PluginApplicationService({ emperorHome })

    const preview = await service.inspect({ kind: 'local', path: archivePath })

    expect(preview).toMatchObject({
      version: '4.0.0',
      source: { kind: 'local', label: 'agent-reach.zip' },
      signature: { status: 'local_user_source' },
    })
    const installed = await service.install({
      previewId: preview.previewId,
      digest: preview.digest,
      scope: 'user',
    })
    expect(installed.plugin).toMatchObject({ enabled: true })
    expect(service.enabledSkillRoots()).toHaveLength(1)
  })
})

function zip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.byteLength + name.byteLength + data.byteLength
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  )
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
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
