import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
      actions: ['open_files'],
    })
    expect(result.id).toMatch(/^ref_[a-f0-9]{24}$/)
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
