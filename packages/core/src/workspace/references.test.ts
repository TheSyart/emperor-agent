import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceReferenceService } from './references'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'emperor-references-'))
  const projectRoot = join(root, 'project')
  const outsideRoot = join(root, 'outside')
  mkdirSync(join(projectRoot, 'docs'), { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'docs', '设计.md'), '# 设计\n', 'utf8')
  writeFileSync(join(outsideRoot, 'secret.md'), 'outside\n', 'utf8')
  symlinkSync(
    join(outsideRoot, 'secret.md'),
    join(projectRoot, 'docs', 'escape.md'),
  )
  const service = new WorkspaceReferenceService({
    resolveProject: (sessionId) => ({ sessionId, projectRoot }),
  })
  return { projectRoot, outsideRoot, service }
}

describe('WorkspaceReferenceService', () => {
  it('resolves an absolute project file and line fragment into a Files action', () => {
    const { projectRoot, service } = fixture()
    const result = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: `${join(projectRoot, 'docs', '设计.md')}#L42`,
      label: '设计说明',
    })

    expect(result).toMatchObject({
      kind: 'project_file',
      label: '设计说明',
      available: true,
      relativePath: 'docs/设计.md',
      line: 42,
      actions: ['open_files', 'preview'],
    })
    expect(result.id).toMatch(/^ref_[a-f0-9]{24}$/)
  })

  it.each([
    'relative-line',
    'relative-column',
    'absolute-line',
    'absolute-column',
    'file-fragment',
    'file-column',
    'file-encoded-name',
    'bare-file',
  ])(
    'parses positioned local references with Chinese names and spaces: %s',
    (form) => {
      const { projectRoot, service } = fixture()
      const path = join(projectRoot, 'docs', '设计 文档.md')
      writeFileSync(path, '# guide')
      writeFileSync(join(projectRoot, 'README.md'), '# readme')
      writeFileSync(
        join(projectRoot, 'docs', '设计 #L2 文档.md'),
        '# encoded name',
      )
      const targets: Record<string, string> = {
        'relative-line': 'docs/设计 文档.md:17',
        'relative-column': 'docs/设计 文档.md:17:9',
        'absolute-line': `${path}:17`,
        'absolute-column': `${path}:17:9`,
        'file-fragment': `${pathToFileURL(path).href}#L17`,
        'file-column': `${pathToFileURL(path).href}:17:9`,
        'file-encoded-name': `${pathToFileURL(join(projectRoot, 'docs', '设计 #L2 文档.md')).href}#L17`,
        'bare-file': 'README.md:17:9',
      }
      expect(
        service.resolve({
          sessionId: 'session-1',
          sourceMessageId: 'message-1',
          href: targets[form]!,
          label: 'Guide',
        }),
      ).toMatchObject({
        kind: 'project_file',
        available: true,
        relativePath:
          form === 'bare-file'
            ? 'README.md'
            : form === 'file-encoded-name'
              ? 'docs/设计 #L2 文档.md'
              : 'docs/设计 文档.md',
        line: 17,
        actions: ['open_files', 'preview'],
      })
    },
  )

  it.each([
    'javascript:12',
    'data:text/plain,hello:12',
    'vbscript:alert(1)',
    'mailto:user@example.com:12',
    'file://remote-host/tmp/report.md#L3',
    'file:///tmp/a%00b#L3',
  ])('rejects unsafe positioned references: %s', (href) => {
    const { service } = fixture()
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href,
        label: 'Unsafe',
      }),
    ).toThrow()
  })

  it('resolves a project-relative path without granting access outside the project', () => {
    const { service } = fixture()
    expect(
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'docs/设计.md',
        label: '',
      }),
    ).toMatchObject({
      kind: 'project_file',
      label: '设计.md',
      relativePath: 'docs/设计.md',
      available: true,
    })

    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: '../outside/secret.md',
        label: 'secret',
      }),
    ).toThrow(/项目外|outside/i)
  })

  it('does not treat a symlink escape as a project file', () => {
    const { service } = fixture()
    const result = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/escape.md',
      label: 'escape',
    })

    expect(result).toMatchObject({
      kind: 'external_file',
      available: true,
      actions: ['reveal'],
    })
    expect(result).not.toHaveProperty('relativePath')
  })

  it('never previews a file outside the session root, only reveals it', async () => {
    const { outsideRoot, service } = fixture()
    const result = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: join(outsideRoot, 'secret.md'),
      label: 'secret',
    })
    expect(result).toMatchObject({
      kind: 'external_file',
      available: true,
      actions: ['reveal'],
    })
    expect(() =>
      service.previewFile({ sessionId: 'session-1', referenceId: result.id }),
    ).toThrow(/无法预览/)
    expect(service.revealPath(result.id, 'session-1')).toBe(
      join(realpathSync(outsideRoot), 'secret.md'),
    )
  })

  it('does not preview a symlink that escapes the project', () => {
    const { service } = fixture()
    const result = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/escape.md',
      label: 'escape',
    })
    expect(() =>
      service.previewFile({ sessionId: 'session-1', referenceId: result.id }),
    ).toThrow(/无法预览/)
  })

  it('previews a project file through its reference', async () => {
    const { service } = fixture()
    const result = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/设计.md',
      label: '',
    })
    const preview = await service.previewFile({
      sessionId: 'session-1',
      referenceId: result.id,
    })
    expect(preview).toMatchObject({ kind: 'text', revealable: false })
    expect(preview.content).toContain('# 设计')
  })

  it('classifies HTTPS links without accepting unsafe protocols or URL credentials', () => {
    const { service } = fixture()
    expect(
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'https://docs.example.com/guide',
        label: '指南',
      }),
    ).toMatchObject({
      kind: 'web',
      label: '指南',
      tooltip: 'https://docs.example.com/guide',
      available: true,
      actions: ['open_external'],
    })
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'http://docs.example.com/guide',
        label: 'insecure',
      }),
    ).toThrow(/https|协议/i)
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'javascript:alert(1)',
        label: 'bad',
      }),
    ).toThrow(/protocol|协议/i)
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'https://token@example.com/secret',
        label: 'bad',
      }),
    ).toThrow(/credential|凭据/i)
  })

  it('rejects plain HTTP web references now that dev-server previews are retired', () => {
    const { service } = fixture()
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'http://127.0.0.1:4173',
        label: '本地预览',
      }),
    ).toThrow(/HTTPS/)
  })

  it('binds an opaque reference to its owner session', () => {
    const { service } = fixture()
    const resolved = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/设计.md',
      label: '设计',
    })

    expect(service.authorize(resolved.id, 'session-1')).toMatchObject({
      kind: 'project_file',
      relativePath: 'docs/设计.md',
    })
    expect(() => service.authorize(resolved.id, 'session-2')).toThrow(
      /session|会话/i,
    )
  })

  it('resolves directories so a link can open them in the Files tree', () => {
    const { projectRoot, outsideRoot, service } = fixture()
    for (const href of ['docs/', 'docs', join(projectRoot, 'docs')])
      expect(
        service.resolve({
          sessionId: 'session-1',
          sourceMessageId: 'message-1',
          href,
          label: 'docs',
        }),
        href,
      ).toMatchObject({
        kind: 'project_file',
        available: true,
        directory: true,
        relativePath: 'docs',
        actions: ['open_files', 'preview'],
      })
    expect(
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: outsideRoot,
        label: 'outside',
      }),
    ).toMatchObject({
      kind: 'external_file',
      available: true,
      directory: true,
      actions: ['reveal'],
    })
    expect(
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: 'message-1',
        href: 'docs/设计.md',
        label: '设计',
      }),
    ).not.toHaveProperty('directory')
  })

  it('reports a missing file, and sees it once it exists', () => {
    const { projectRoot, service } = fixture()
    const input = {
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/later.md',
      label: 'later',
    }
    const missing = service.resolve(input)
    expect(missing).toMatchObject({
      kind: 'project_file',
      available: false,
      relativePath: 'docs/later.md',
      actions: [],
    })
    writeFileSync(join(projectRoot, 'docs', 'later.md'), 'now\n', 'utf8')
    const found = service.resolve(input)
    expect(found).toMatchObject({
      available: true,
      actions: ['open_files', 'preview'],
    })
    expect(found.id).toBe(missing.id)
    expect(service.authorize(found.id, 'session-1').available).toBe(true)
  })

  it('caches only the same source-message and normalized target binding', () => {
    const { service } = fixture()
    const first = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/设计.md',
      label: '设计',
    })
    const repeated = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      href: 'docs/设计.md',
      label: '另一个标签不扩大权限',
    })
    const otherMessage = service.resolve({
      sessionId: 'session-1',
      sourceMessageId: 'message-2',
      href: 'docs/设计.md',
      label: '设计',
    })

    expect(repeated.id).toBe(first.id)
    expect(otherMessage.id).not.toBe(first.id)
    expect(() =>
      service.resolve({
        sessionId: 'session-1',
        sourceMessageId: '',
        href: 'docs/设计.md',
        label: '设计',
      }),
    ).toThrow(/来源|source/i)
  })
})
