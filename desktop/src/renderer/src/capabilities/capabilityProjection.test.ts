import { describe, expect, it } from 'vitest'

import type { AttachmentRef, SkillInfo, ToolInfo } from '../types'
import {
  attachmentCapability,
  mcpServerCapability,
  skillCapability,
  toolCapability,
} from './capabilityProjection'

describe('capability projection', () => {
  it('surfaces blocked Skill state as a first-class badge', () => {
    const skill: SkillInfo = {
      name: 'blocked-skill',
      description: 'Needs Python',
      path: 'skills/blocked-skill/SKILL.md',
      tags: '',
      always: false,
      source: 'user',
      status: 'blocked',
      readOnly: false,
      requirements: { bins: [], runtimes: ['python'], env: [] },
    }

    expect(skillCapability(skill).badges[0]).toEqual({
      label: 'blocked',
      tone: 'red',
    })
  })

  it('projects attachments into compact composer capability rows', () => {
    const attachment: AttachmentRef = {
      id: 'att_pdf',
      name: 'audit-report.pdf',
      mime: 'application/pdf',
      size: 2048,
      kind: 'document',
      hasText: true,
      hasImage: false,
      path: '/tmp/audit-report.pdf',
    }

    const item = attachmentCapability(attachment)

    expect(item.kind).toBe('attachment')
    expect(item.title).toBe('PDF')
    expect(item.name).toBe('audit-report.pdf')
    expect(item.tone).toBe('red')
    expect(item.meta).toContain('2.0 KB')
  })

  it('projects skills with readable title, tags, and cyan skill tone', () => {
    const skill: SkillInfo = {
      name: 'components-build',
      description: 'Build modern accessible React UI components.',
      path: 'skills/components-build/SKILL.md',
      tags: 'ui react',
    }

    const item = skillCapability(skill)

    expect(item.kind).toBe('skill')
    expect(item.title).toBe('Components Build')
    expect(item.name).toBe('components-build')
    expect(item.tone).toBe('cyan')
    expect(item.badges.map((badge) => badge.label)).toContain('ui')
    expect(item.badges.length).toBeLessThanOrEqual(5)
  })

  it('projects builtin and MCP tools with source and permission badges', () => {
    const builtin: ToolInfo = {
      name: 'read_file',
      description: '安全读取文本文件。',
      read_only: true,
      concurrency_safe: true,
      source: 'builtin',
    }
    const mcp: ToolInfo = {
      name: 'mcp_github_create_issue',
      description: '创建 GitHub issue。',
      read_only: false,
      source: 'mcp',
      server: 'github',
    }

    expect(toolCapability(builtin).badges.map((badge) => badge.label)).toEqual([
      '只读',
      '并发',
    ])
    expect(toolCapability(mcp).kind).toBe('mcp')
    expect(toolCapability(mcp).badges.map((badge) => badge.label)).toContain(
      'github',
    )
    expect(toolCapability(mcp).badges.map((badge) => badge.label)).toContain(
      '可写',
    )
  })

  it('projects MCP servers from config status', () => {
    const item = mcpServerCapability(
      'github',
      {
        transport: 'stdio',
        enabled: true,
        command: 'github-mcp-server',
      },
      4,
    )

    expect(item.kind).toBe('mcp')
    expect(item.title).toBe('GitHub')
    expect(item.description).toBe('stdio · github-mcp-server')
    expect(item.badges.map((badge) => badge.label)).toEqual([
      '未连接',
      '4 工具',
    ])
  })

  it('shows MCP auth and generation diagnostics instead of inferring health from an empty tool list', () => {
    const item = mcpServerCapability(
      'private-api',
      { transport: 'sse', enabled: true, url: 'https://mcp.example.test' },
      0,
      {
        serverName: 'private-api',
        transport: 'sse',
        generation: 3,
        clientId: 'client_3',
        state: 'auth_failed',
        health: 'unhealthy',
        auth: 'failed',
        toolCount: 0,
        lastError: {
          code: 'mcp_auth_failed',
          message: 'MCP server authentication failed',
        },
      },
    )

    expect(item.meta).toContain('认证失败')
    expect(item.description).toContain('authentication failed')
    expect(item.badges).toEqual([
      { label: '认证失败', tone: 'red' },
      { label: '0 工具', tone: 'blue' },
      { label: 'G3', tone: 'slate' },
    ])
  })
})
