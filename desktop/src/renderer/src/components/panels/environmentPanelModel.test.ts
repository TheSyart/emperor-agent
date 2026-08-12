import { describe, expect, it } from 'vitest'
import type { CoreOperationResult } from '@emperor/core/api'
import {
  environmentJobStatusLabel,
  environmentJobTone,
  environmentToolSections,
  environmentToolStatusLabel,
  environmentToolTone,
} from './environmentPanelModel'

type StatusPayload = CoreOperationResult<'environment.getStatus'>

describe('environment panel model', () => {
  it('groups ready, missing, mismatched, blocked and large dependencies', () => {
    const payload = statusPayload()

    expect(
      environmentToolSections(payload).map((group) => group.title),
    ).toEqual(['基础工具', '当前项目', 'Skill 依赖', '大型依赖'])
    expect(environmentToolTone('ready')).toBe('ok')
    expect(environmentToolTone('missing')).toBe('warn')
    expect(environmentToolTone('blocked')).toBe('error')
    expect(environmentToolStatusLabel('version_mismatch')).toBe('版本不匹配')
  })

  it('keeps historical job state readable without exposing install actions', () => {
    expect(environmentJobStatusLabel('partial')).toBe('部分完成')
    expect(environmentJobTone('completed')).toBe('ok')
    expect(environmentJobTone('failed')).toBe('error')
  })
})

function statusPayload(): StatusPayload {
  const tool = (
    id: 'git' | 'node' | 'python' | 'msvc-build-tools',
    category: StatusPayload['status']['tools'][number]['category'],
    status: StatusPayload['status']['tools'][number]['status'],
    installStrategy: string | null,
  ) => ({
    id,
    category,
    required: true,
    reason: `${id} required`,
    declarationSource: null,
    status,
    detectedVersion: status === 'ready' ? '1.0.0' : null,
    versionSummary: null,
    requiredVersion: '>=1.0.0',
    executablePath: status === 'ready' ? `/tools/${id}` : null,
    installStrategy,
    sourceUrl: installStrategy ? 'https://example.com/tool.zip' : null,
    requiresElevation: id === 'msvc-build-tools',
    requiresSeparateConfirmation: id === 'msvc-build-tools',
  })
  return {
    status: {
      cacheKey: 'd'.repeat(64),
      catalogRevision: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      project: {
        projectRoot: '/workspace',
        fingerprint: 'b'.repeat(64),
        declarations: {} as StatusPayload['status']['project']['declarations'],
        files: [],
        diagnostics: [],
      },
      platform: 'darwin',
      arch: 'arm64',
      pathEntries: ['/usr/bin'],
      tools: [
        tool('git', 'base', 'missing', 'git-system'),
        tool('node', 'project', 'version_mismatch', 'node-volta'),
        tool('python', 'skill', 'blocked', null),
        tool('msvc-build-tools', 'large-prerequisite', 'unsupported', null),
      ],
      skills: [],
      diagnostics: [],
    },
    catalog: {
      revision: 'a'.repeat(64),
      release: '2026.07',
      licenses: [
        {
          id: 'git-gpl-2',
          name: 'GNU GPL 2.0',
          spdx: 'GPL-2.0-only',
          url: 'https://example.com/license',
        },
      ],
      tools: [
        {
          id: 'git',
          displayName: 'Git',
          pinnedVersion: '2.55.0',
          licenseId: 'git-gpl-2',
          strategies: [
            {
              id: 'git-system',
              kind: 'package_manager',
              sourceUrl: 'https://git-scm.com',
              publisher: 'Git Project',
              estimatedBytes: 10_000_000,
              requiresElevation: true,
              requiresSeparateConfirmation: false,
              cancellable: true,
            },
          ],
        },
      ],
    },
    activeJob: null,
    recentJobs: [],
    managed: { schemaVersion: 1, tools: {}, jobs: [] },
  } as StatusPayload
}
