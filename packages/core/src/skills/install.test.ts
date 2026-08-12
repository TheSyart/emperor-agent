import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssetDownloader } from '../environment/download'
import { isSkillBlocked } from '../runtime/resources'
import { SkillManager } from './manager'
import { SkillInstallService, type SkillMissingRequirements } from './install'

describe('SkillInstallService', () => {
  it('preserves a legacy blocked receipt without making it resolver authority', async () => {
    const missing: SkillMissingRequirements = {
      bins: [],
      runtimes: [],
      env: ['SERVICE_TOKEN'],
    }
    const fixture = installFixture({ missing })
    const archive = fixture.archive(
      zip([
        {
          name: 'review-skill/SKILL.md',
          data: skillContent('review-skill', {
            bins: ['git'],
            env: ['SERVICE_TOKEN'],
          }),
        },
        {
          name: 'review-skill/scripts/run.sh',
          data: '#!/bin/sh\ngit status\n',
        },
      ]),
    )

    const preview = await fixture.service.previewInstall({
      source: { kind: 'local', path: archive },
    })

    expect(preview).toMatchObject({
      previewId: 'preview_aaaaaaaaaaaaaaaaaaaaaaaa',
      source: { kind: 'local' },
      candidates: [
        {
          name: 'review-skill',
          valid: true,
          fileCount: 2,
          files: ['SKILL.md', 'scripts/run.sh'],
          scripts: [{ path: 'scripts/run.sh', type: 'shell' }],
          externalCommands: ['git'],
          environmentVariables: ['SERVICE_TOKEN'],
          missing,
        },
      ],
    })
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      fixture.service.confirmInstall({
        previewId: preview.previewId,
        digest: preview.digest,
        candidateId: preview.candidates[0]!.candidateId,
        permissionConfirmed: false,
      }),
    ).rejects.toThrow(/permission|confirm/i)
    await expect(
      fixture.service.confirmInstall({
        previewId: preview.previewId,
        digest: '0'.repeat(64),
        candidateId: preview.candidates[0]!.candidateId,
        permissionConfirmed: true,
      }),
    ).rejects.toThrow(/digest|stale/i)

    const installed = await fixture.service.confirmInstall({
      previewId: preview.previewId,
      digest: preview.digest,
      candidateId: preview.candidates[0]!.candidateId,
      permissionConfirmed: true,
    })

    expect(installed).toMatchObject({
      name: 'review-skill',
      status: 'blocked',
      missing,
    })
    const target = join(fixture.stateRoot, 'skills', 'review-skill')
    expect(isSkillBlocked(target)).toBe(true)
    expect(fixture.manager.resolve('review-skill')?.status).toBe('active')
    expect(existsSync(join(target, 'scripts', 'run.sh'))).toBe(true)
    expect(existsSync(join(fixture.stateRoot, 'skills', '.staging'))).toBe(true)
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.stateRoot, 'skills', 'installed.v1.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      skills: {
        'review-skill': {
          sourceDigest: preview.digest,
          status: 'blocked',
          missing,
        },
      },
    })
  })

  it('ignores a legacy blocked receipt while the filesystem Skill stays active', async () => {
    let missing: SkillMissingRequirements = {
      bins: ['git'],
      runtimes: [],
      env: [],
    }
    const fixture = installFixture({
      resolveMissing: async () => missing,
    })
    const preview = await fixture.previewSingle('dependency-skill', '# Skill', {
      bins: ['git'],
    })
    await fixture.confirm(preview)
    expect(fixture.manager.resolve('dependency-skill')?.status).toBe('active')

    missing = { bins: [], runtimes: [], env: [] }
    await expect(fixture.service.reconcileBlocked()).resolves.toEqual({
      activated: [],
      blocked: [],
    })
    expect(fixture.manager.resolve('dependency-skill')?.status).toBe('active')
  })

  it('requires an explicit candidate when a repository contains multiple Skills', async () => {
    const fixture = installFixture()
    const archive = fixture.archive(
      zip([
        { name: 'repo/skills/alpha/SKILL.md', data: skillContent('alpha') },
        { name: 'repo/skills/beta/SKILL.md', data: skillContent('beta') },
      ]),
    )
    const preview = await fixture.service.previewInstall({
      source: { kind: 'local', path: archive },
    })

    expect(preview.candidates.map((candidate) => candidate.name)).toEqual([
      'alpha',
      'beta',
    ])
    await expect(
      fixture.service.confirmInstall({
        previewId: preview.previewId,
        digest: preview.digest,
        permissionConfirmed: true,
      }),
    ).rejects.toThrow(/candidate/i)
  })

  it('expires previews and rejects archive or extracted candidate mutation', async () => {
    const fixture = installFixture()
    const preview = await fixture.previewSingle('stale-skill')
    fixture.clock.value = Date.parse('2026-07-11T10:11:00.000Z')
    await expect(fixture.confirm(preview)).rejects.toThrow(/expired/i)

    const freshFixture = installFixture()
    const fresh = await freshFixture.previewSingle('changed-skill')
    writeFileSync(
      join(
        freshFixture.stateRoot,
        'skills',
        '.staging',
        fresh.previewId,
        'archive.zip',
      ),
      'changed',
    )
    await expect(freshFixture.confirm(fresh)).rejects.toThrow(/digest|stale/i)

    const sourceFixture = installFixture()
    const sourcePreview = await sourceFixture.previewSingle('source-changed')
    writeFileSync(sourcePreview.source.path!, 'changed source')
    await expect(sourceFixture.confirm(sourcePreview)).rejects.toThrow(
      /source|digest|changed/i,
    )

    const candidateFixture = installFixture()
    const candidatePreview =
      await candidateFixture.previewSingle('candidate-changed')
    writeFileSync(
      join(
        candidateFixture.stateRoot,
        'skills',
        '.staging',
        candidatePreview.previewId,
        'extracted',
        candidatePreview.candidates[0]!.relativeRoot,
        'SKILL.md',
      ),
      skillContent('candidate-changed', {}, 'mutated'),
    )
    await expect(candidateFixture.confirm(candidatePreview)).rejects.toThrow(
      /candidate|digest|changed/i,
    )

    const stateFixture = installFixture()
    const statePreview = await stateFixture.previewSingle('state-changed')
    const statePath = join(
      stateFixture.stateRoot,
      'skills',
      '.staging',
      statePreview.previewId,
      'preview.json',
    )
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.source.path = `${state.source.path}.other`
    writeFileSync(statePath, JSON.stringify(state))
    await expect(stateFixture.confirm(statePreview)).rejects.toThrow(
      /source|state|changed/i,
    )
  })

  it('normalizes public GitHub repo/tree URLs and filters a tree candidate', async () => {
    const archive = zip([
      { name: 'repo-main/skills/alpha/SKILL.md', data: skillContent('alpha') },
      { name: 'repo-main/skills/beta/SKILL.md', data: skillContent('beta') },
    ])
    const requests: string[] = []
    const downloader: AssetDownloader = {
      download: async ({ url, destination }) => {
        requests.push(url)
        if (url.endsWith('/commits/feature%2Ffoo'))
          writeFileSync(destination, JSON.stringify({ sha: 'a'.repeat(40) }))
        else if (url.endsWith('/commits/main'))
          writeFileSync(destination, JSON.stringify({ sha: 'b'.repeat(40) }))
        else if (url.includes('/commits/')) throw new Error('commit not found')
        else if (url.startsWith('https://api.github.com/'))
          writeFileSync(destination, JSON.stringify({ default_branch: 'main' }))
        else writeFileSync(destination, archive)
      },
    }
    const repoFixture = installFixture({ downloader })
    const repo = await repoFixture.service.previewInstall({
      source: { kind: 'url', url: 'https://github.com/acme/repo' },
    })
    expect(repo.source).toMatchObject({
      kind: 'github_repo',
      repository: 'acme/repo',
      ref: 'b'.repeat(40),
      resolvedUrl: `https://codeload.github.com/acme/repo/zip/${'b'.repeat(40)}`,
    })
    expect(repo.candidates).toHaveLength(2)
    expect(requests[0]).toBe('https://api.github.com/repos/acme/repo')

    const treeFixture = installFixture({ downloader })
    const tree = await treeFixture.service.previewInstall({
      source: {
        kind: 'url',
        url: 'https://github.com/acme/repo/tree/feature/foo/skills/beta',
      },
    })
    expect(tree.source).toMatchObject({
      kind: 'github_tree',
      repository: 'acme/repo',
      ref: 'a'.repeat(40),
      requestedPath: 'skills/beta',
    })
    expect(tree.candidates.map((candidate) => candidate.name)).toEqual(['beta'])

    const rawFixture = installFixture({ downloader })
    const raw = await rawFixture.service.previewInstall({
      source: {
        kind: 'url',
        url: 'https://raw.githubusercontent.com/acme/repo/main/docs/install.md',
      },
    })
    expect(raw.source).toMatchObject({
      kind: 'github_tree',
      repository: 'acme/repo',
      ref: 'b'.repeat(40),
      requestedPath: null,
    })
    expect(raw.candidates.map((candidate) => candidate.name)).toEqual([
      'alpha',
      'beta',
    ])

    const blobFixture = installFixture({ downloader })
    const blob = await blobFixture.service.previewInstall({
      source: {
        kind: 'url',
        url: 'https://github.com/acme/repo/blob/main/skills/beta/SKILL.md',
      },
    })
    expect(blob.source).toMatchObject({
      ref: 'b'.repeat(40),
      requestedPath: 'skills/beta',
    })
    expect(blob.candidates.map((candidate) => candidate.name)).toEqual(['beta'])
  })

  it('accepts HTTPS .skill/.zip links and rejects unsupported network sources', async () => {
    const archive = zip([
      { name: 'direct-skill/SKILL.md', data: skillContent('direct-skill') },
    ])
    const fixture = installFixture({
      downloader: {
        download: async ({ destination }) =>
          writeFileSync(destination, archive),
      },
    })
    const preview = await fixture.service.previewInstall({
      source: {
        kind: 'url',
        url: 'https://downloads.example.com/direct-skill.skill',
      },
    })
    expect(preview.source).toMatchObject({ kind: 'direct_https' })

    for (const url of [
      'http://example.com/skill.zip',
      'https://example.com/page',
      'https://user:secret@example.com/skill.zip',
      'https://example.com/skill.zip?token=secret',
    ])
      await expect(
        installFixture().service.previewInstall({
          source: { kind: 'url', url },
        }),
        url,
      ).rejects.toThrow(/source|url|https|GitHub/i)
  })

  it('rejects unsafe local archives and traversal members before install', async () => {
    const fixture = installFixture()
    const linked = join(fixture.stateRoot, 'linked.skill')
    const outside = fixture.archive(
      zip([{ name: 'safe/SKILL.md', data: skillContent('safe') }]),
    )
    symlinkSync(outside, linked)
    await expect(
      fixture.service.previewInstall({
        source: { kind: 'local', path: linked },
      }),
    ).rejects.toThrow(/regular|symbolic|unsafe/i)

    const traversal = fixture.archive(
      zip([{ name: '../escape/SKILL.md', data: skillContent('escape') }]),
    )
    await expect(
      fixture.service.previewInstall({
        source: { kind: 'local', path: traversal },
      }),
    ).rejects.toThrow(/path|unsafe/i)
    expect(existsSync(join(fixture.stateRoot, 'escape'))).toBe(false)
  })

  it('restores an existing Skill when final directory activation fails', async () => {
    const fixture = installFixture({
      rename: (source, target) => {
        if (basename(String(source)).startsWith('.skill-install-')) {
          const error = new Error('injected activation failure') as Error & {
            code: string
          }
          error.code = 'EIO'
          throw error
        }
        renameSync(source, target)
      },
    })
    const existing = join(fixture.stateRoot, 'skills', 'replace-skill')
    mkdirSync(existing, { recursive: true })
    writeFileSync(
      join(existing, 'SKILL.md'),
      skillContent('replace-skill', {}, 'old'),
    )
    const preview = await fixture.previewSingle('replace-skill', 'new')

    await expect(fixture.confirm(preview)).rejects.toThrow(/activation failure/)
    expect(readFileSync(join(existing, 'SKILL.md'), 'utf8')).toContain('old')
  })

  it('allows a preview to be confirmed only once at a time', async () => {
    const fixture = installFixture()
    const preview = await fixture.previewSingle('once-skill')
    const input = {
      previewId: preview.previewId,
      digest: preview.digest,
      candidateId: preview.candidates[0]!.candidateId,
      permissionConfirmed: true,
    }

    const results = await Promise.allSettled([
      fixture.service.confirmInstall(input),
      fixture.service.confirmInstall(input),
    ])

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    expect(fixture.manager.resolve('once-skill')?.status).toBe('active')
  })
})

interface FixtureOptions {
  missing?: SkillMissingRequirements
  resolveMissing?: () => Promise<SkillMissingRequirements>
  downloader?: AssetDownloader
  rename?: typeof renameSync
}

function installFixture(opts: FixtureOptions = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-skill-install-'))
  const runtimeRoot = join(stateRoot, 'runtime')
  mkdirSync(runtimeRoot)
  const manager = new SkillManager({ stateRoot, runtimeRoot })
  const clock = { value: Date.parse('2026-07-11T10:00:00.000Z') }
  const resolveMissing =
    opts.resolveMissing ??
    (async () => opts.missing ?? { bins: [], runtimes: [], env: [] })
  const service = new SkillInstallService({
    manager,
    stateRoot,
    downloader: opts.downloader,
    now: () => new Date(clock.value),
    idFactory: () => 'preview_aaaaaaaaaaaaaaaaaaaaaaaa',
    resolveMissing,
    rename: opts.rename,
  })
  let archiveIndex = 0
  const archive = (bytes: Buffer): string => {
    archiveIndex += 1
    const path = join(stateRoot, `source-${archiveIndex}.skill`)
    writeFileSync(path, bytes)
    return path
  }
  const previewSingle = async (
    name: string,
    body = '# Skill',
    requirements: {
      bins?: string[]
      runtimes?: string[]
      env?: string[]
    } = {},
  ) =>
    await service.previewInstall({
      source: {
        kind: 'local',
        path: archive(
          zip([
            {
              name: `${name}/SKILL.md`,
              data: skillContent(name, requirements, body),
            },
          ]),
        ),
      },
    })
  const confirm = async (preview: Awaited<ReturnType<typeof previewSingle>>) =>
    await service.confirmInstall({
      previewId: preview.previewId,
      digest: preview.digest,
      candidateId: preview.candidates[0]!.candidateId,
      permissionConfirmed: true,
    })
  return {
    stateRoot,
    manager,
    service,
    clock,
    archive,
    previewSingle,
    confirm,
  }
}

function skillContent(
  name: string,
  requirements: {
    bins?: string[]
    runtimes?: string[]
    env?: string[]
  } = {},
  body = '# Skill',
): string {
  const metadata =
    requirements.bins || requirements.runtimes || requirements.env
      ? [
          'metadata:',
          '  emperor:',
          '    requires:',
          ...(requirements.bins
            ? [`      bins: [${requirements.bins.join(', ')}]`]
            : []),
          ...(requirements.runtimes
            ? [`      runtimes: [${requirements.runtimes.join(', ')}]`]
            : []),
          ...(requirements.env
            ? [`      env: [${requirements.env.join(', ')}]`]
            : []),
        ]
      : []
  return [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    ...metadata,
    '---',
    '',
    body,
    '',
  ].join('\n')
}

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
    local.writeUInt16LE(0, 8)
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
    central.writeUInt16LE(0, 10)
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
