import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PublicHttpRequest } from '../network/public-http'
import { importSkills, parseSkillImportUrl } from './import'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-skill-import-test-'))
  const target = join(root, 'skills')
  mkdirSync(target)
  return { root, target }
}

function skillText(name: string, description = `${name} skill`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`
}

describe('parseSkillImportUrl', () => {
  it('maps GitHub repository and folder links to codeload archives', () => {
    expect(parseSkillImportUrl('https://github.com/acme/skills')).toMatchObject(
      {
        kind: 'github',
        owner: 'acme',
        repo: 'skills',
        ref: null,
        dir: '',
        downloads: [
          'https://codeload.github.com/acme/skills/zip/HEAD',
          'https://github.com/acme/skills/archive/HEAD.zip',
        ],
      },
    )
    expect(
      parseSkillImportUrl(
        'https://github.com/acme/skills/tree/main/skills/pdf-tools',
      ),
    ).toMatchObject({
      ref: 'main',
      dir: 'skills/pdf-tools',
      downloads: [
        'https://codeload.github.com/acme/skills/zip/refs/heads/main',
        'https://codeload.github.com/acme/skills/zip/refs/tags/main',
      ],
    })
    expect(
      parseSkillImportUrl(
        'https://github.com/acme/skills/blob/0123abc/tools/SKILL.md',
      ),
    ).toMatchObject({
      ref: '0123abc',
      dir: 'tools',
      downloads: ['https://codeload.github.com/acme/skills/zip/0123abc'],
    })
    expect(
      parseSkillImportUrl('https://example.com/downloads/skill.zip'),
    ).toMatchObject({
      kind: 'zip',
      downloads: ['https://example.com/downloads/skill.zip'],
    })
  })

  it('rejects non-https and credential links', () => {
    expect(() => parseSkillImportUrl('http://github.com/a/b')).toThrow(/https/)
    expect(() => parseSkillImportUrl('https://u:p@example.com/a.zip')).toThrow(
      /credentials/,
    )
    expect(() => parseSkillImportUrl('not a url')).toThrow(/valid https/)
  })
})

describe('importSkills', () => {
  it('imports pasted SKILL.md content and refuses an existing name without overwrite', async () => {
    const { target } = workspace()
    const first = await importSkills({
      source: { kind: 'content', content: skillText('pasted') },
      targetDir: target,
      scope: 'user',
    })
    expect(first).toEqual({
      imported: [
        {
          name: 'pasted',
          scope: 'user',
          path: join(target, 'pasted'),
          warnings: [],
          replaced: false,
        },
      ],
      errors: [],
    })
    const again = await importSkills({
      source: { kind: 'content', content: skillText('pasted', 'v2') },
      targetDir: target,
      scope: 'user',
    })
    expect(again.imported).toEqual([])
    expect(again.errors).toEqual([
      {
        code: 'skill_exists',
        name: 'pasted',
        path: '.',
        reason: expect.stringMatching(/already exists/),
      },
    ])
    const replaced = await importSkills({
      source: { kind: 'content', content: skillText('pasted', 'v2') },
      targetDir: target,
      scope: 'user',
      overwrite: true,
    })
    expect(replaced.imported[0]).toMatchObject({ replaced: true })
    expect(readFileSync(join(target, 'pasted', 'SKILL.md'), 'utf8')).toContain(
      'description: v2',
    )
    await expect(
      importSkills({
        source: { kind: 'content', content: '# No frontmatter\n' },
        targetDir: target,
        scope: 'user',
      }),
    ).rejects.toMatchObject({ code: 'skill_invalid' })
  })

  it('imports a local folder with internal links and skips dependency folders', async () => {
    const { root, target } = workspace()
    const source = join(root, 'source', 'my-tool')
    mkdirSync(join(source, 'scripts'), { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), skillText('my-tool'))
    writeFileSync(join(source, 'scripts', 'run.sh'), 'echo hi\n')
    symlinkSync(join('scripts', 'run.sh'), join(source, 'run.sh'))
    mkdirSync(join(source, '.venv', 'bin'), { recursive: true })
    symlinkSync('/usr/bin/python3', join(source, '.venv', 'bin', 'python'))

    const result = await importSkills({
      source: { kind: 'folder', path: source },
      targetDir: target,
      scope: 'project',
    })

    expect(result.errors).toEqual([])
    expect(result.imported).toEqual([
      expect.objectContaining({
        name: 'my-tool',
        scope: 'project',
        warnings: [expect.stringMatching(/Not copied: \.venv/)],
      }),
    ])
    const installed = join(target, 'my-tool')
    expect(readFileSync(join(installed, 'scripts', 'run.sh'), 'utf8')).toBe(
      'echo hi\n',
    )
    expect(lstatSync(join(installed, 'run.sh')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(installed, 'run.sh'))).toBe(
      join('scripts', 'run.sh'),
    )
    expect(existsSync(join(installed, '.venv'))).toBe(false)
  })

  it('imports every Skill of a zip and reports invalid ones per Skill', async () => {
    const { root, target } = workspace()
    const archive = join(root, 'bundle.zip')
    writeFileSync(
      archive,
      zip([
        { name: 'bundle/alpha/SKILL.md', data: skillText('alpha') },
        { name: 'bundle/alpha/references/a.md', data: '# A\n' },
        { name: 'bundle/nested/beta/SKILL.md', data: skillText('beta') },
        { name: 'bundle/zeta/SKILL.md', data: skillText('alpha', 'copy') },
        {
          name: 'bundle/broken/SKILL.md',
          data: '---\nname: broken\n---\nNo description\n',
        },
        { name: 'bundle/README.md', data: '# Bundle\n' },
      ]),
    )

    const result = await importSkills({
      source: { kind: 'zip', path: archive },
      targetDir: target,
      scope: 'user',
    })

    expect(result.imported.map((skill) => skill.name)).toEqual([
      'alpha',
      'beta',
    ])
    expect(result.errors).toEqual([
      {
        code: 'skill_invalid',
        name: 'broken',
        path: 'bundle/broken',
        reason: 'Frontmatter field "description" is required',
      },
      {
        code: 'skill_duplicate',
        name: 'alpha',
        path: 'bundle/zeta',
        reason: 'Another Skill in this import is also named "alpha"',
      },
    ])
    expect(existsSync(join(target, 'alpha', 'references', 'a.md'))).toBe(true)
    expect(existsSync(join(target, 'beta', 'SKILL.md'))).toBe(true)
    await expect(
      importSkills({
        source: { kind: 'zip', path: join(root, 'missing.zip') },
        targetDir: target,
        scope: 'user',
      }),
    ).rejects.toMatchObject({ code: 'skill_import_failed' })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a failed copy into the target folder as skill_import_failed',
    async () => {
      const { root, target } = workspace()
      const source = join(root, 'source', 'locked')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'SKILL.md'), skillText('locked'))
      chmodSync(target, 0o500)
      try {
        const result = await importSkills({
          source: { kind: 'folder', path: source },
          targetDir: target,
          scope: 'user',
        })
        expect(result.imported).toEqual([])
        expect(result.errors).toEqual([
          expect.objectContaining({
            code: 'skill_import_failed',
            name: 'locked',
            path: '.',
          }),
        ])
      } finally {
        chmodSync(target, 0o700)
      }
    },
  )

  it('downloads a GitHub folder link through the injected https client', async () => {
    const { target } = workspace()
    const archive = zip([
      { name: 'skills-main/README.md', data: '# Repo\n' },
      { name: 'skills-main/skills/pdf/SKILL.md', data: skillText('pdf') },
      { name: 'skills-main/skills/other/SKILL.md', data: skillText('other') },
    ])
    const get = vi.fn(async (request: PublicHttpRequest) =>
      request.url.includes('/refs/heads/')
        ? {
            url: request.url,
            status: 404,
            headers: {},
            body: new Uint8Array(),
          }
        : { url: request.url, status: 200, headers: {}, body: archive },
    )

    const result = await importSkills({
      source: {
        kind: 'url',
        url: 'https://github.com/acme/skills/tree/v1/skills/pdf',
      },
      targetDir: target,
      scope: 'user',
      fetchClient: { get },
    })

    expect(result.imported.map((skill) => skill.name)).toEqual(['pdf'])
    expect(get.mock.calls.map(([request]) => request.url)).toEqual([
      'https://codeload.github.com/acme/skills/zip/refs/heads/v1',
      'https://codeload.github.com/acme/skills/zip/refs/tags/v1',
    ])
    expect(get.mock.calls[0]![0]).toMatchObject({
      protocols: ['https:'],
      redirectMode: 'follow_validated',
    })
    await expect(
      importSkills({
        source: {
          kind: 'url',
          url: 'https://github.com/acme/skills/tree/v1/skills/missing',
        },
        targetDir: target,
        scope: 'user',
        fetchClient: { get },
      }),
    ).rejects.toThrow(/Folder "skills\/missing" was not found/)
    await expect(
      importSkills({
        source: { kind: 'url', url: 'https://example.com/page' },
        targetDir: target,
        scope: 'user',
        fetchClient: {
          get: async (request) => ({
            url: request.url,
            status: 200,
            headers: {},
            body: new TextEncoder().encode('<html></html>'),
          }),
        },
      }),
    ).rejects.toThrow(/did not return a zip archive/)
    await expect(
      importSkills({
        source: { kind: 'url', url: 'https://example.com/a.zip' },
        targetDir: target,
        scope: 'user',
      }),
    ).rejects.toThrow(/not available/)
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
