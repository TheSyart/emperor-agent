import { describe, expect, it } from 'vitest'

import type { AttachmentRef, SkillInfo, ToolInfo } from '../types'
import {
  attachmentCapability,
  mcpServerCapability,
  skillCapability,
  toolCapability,
} from './capabilityProjection'

describe('capability projection', () => {
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

    expect(toolCapability(builtin).badges.map((badge) => badge.label)).toEqual(['只读', '并发'])
    expect(toolCapability(mcp).kind).toBe('mcp')
    expect(toolCapability(mcp).badges.map((badge) => badge.label)).toContain('github')
    expect(toolCapability(mcp).badges.map((badge) => badge.label)).toContain('可写')
  })

  it('projects MCP servers from config status', () => {
    const item = mcpServerCapability('github', {
      transport: 'stdio',
      enabled: true,
      command: 'github-mcp-server',
    }, 4)

    expect(item.kind).toBe('mcp')
    expect(item.title).toBe('GitHub')
    expect(item.description).toBe('stdio · github-mcp-server')
    expect(item.badges.map((badge) => badge.label)).toEqual(['启用', '4 工具'])
  })
})
