// GRP-02 card test 11: compileRolePrompt is a pure function of its input —
// the same contact gives the same bytes (golden files), with 群聊习惯 only
// inside a group and 记忆 only when GRP-03 hands it memory.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileRolePrompt } from './compile'
import type { Contact } from './types'

const GOLDEN = join(__dirname, '__golden__')

function golden(name: string): string {
  return readFileSync(join(GOLDEN, name), 'utf8')
}

const AUDITOR: Contact = {
  id: 'ct-abcdefghijkl',
  kind: 'local',
  name: '安全审计',
  avatar: { kind: 'library', id: 'AV-01-4' },
  intro: '审查改动里的注入、越权和密钥泄漏',
  domains: ['security', 'engineering'],
  role: {
    mission: '审查每一处改动的安全问题。\r\n只看安全，不评代码风格。',
    deliverable:
      '按严重程度排序的问题清单，每条写：位置 · 问题 · 影响 · 修法 · 置信度。',
    playbook:
      '1. 找信任边界\n2. 顺着数据流看输入、校验和使用\n3. 查密钥\n4. 查依赖',
    boundaries: '不改代码；发现严重问题立刻报告。',
    knowledge: [
      { kind: 'file', path: '/Users/me/security/checklist.md', pinned: true },
      { kind: 'folder', path: '/Users/me/security/incidents' },
      { kind: 'url', url: 'https://owasp.org/Top10/' },
      { kind: 'skill', name: 'threat-model' },
    ],
    examples: [
      {
        input: '审查 login.ts 的改动',
        output: '1. 高 · login.ts:42 · 拼接 SQL · 可注入 · 改用参数化查询 · 高',
      },
    ],
    trialTask: '审查一段带 SQL 拼接的登录代码。',
  },
  capabilities: {
    model: 'inherit',
    tools: { preset: 'read_only' },
    permission: 'read_only',
  },
  groupHabit: { speak: 'relevant', length: 'brief' },
  memory: { enabled: true },
  version: 3,
  templateId: 'security-auditor',
  builtin: false,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_100_000,
}

/** The same contact with every object's keys in reverse order. */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversedKeys(item)]),
    ) as T
  return value
}

describe('compileRolePrompt (card test 11)', () => {
  it('matches the golden prompt outside a group', () => {
    const prompt = compileRolePrompt(AUDITOR)
    expect(prompt).toBe(golden('role-prompt.md'))
    expect(prompt).not.toContain('# 群聊习惯')
    expect(prompt).not.toContain('# 记忆')
  })

  it('matches the golden prompt inside a group, with memory', () => {
    const prompt = compileRolePrompt(AUDITOR, {
      inGroup: {
        title: '发布评审',
        charter: '目标：今天定下 0.3 能不能发。\n约束：不改发布分支。',
      },
      memory: '- 2026-10-20 用户：报告里先写结论，再写细节。',
    })
    expect(prompt).toBe(golden('role-prompt.group.md'))
  })

  it('is byte-identical for the same input, whatever the key order', () => {
    const first = compileRolePrompt(AUDITOR, { inGroup: {} })
    expect(compileRolePrompt(structuredClone(AUDITOR), { inGroup: {} })).toBe(
      first,
    )
    expect(compileRolePrompt(reversedKeys(AUDITOR), { inGroup: {} })).toBe(
      first,
    )
    // What the prompt does not show (avatar, version, times) changes nothing.
    expect(
      compileRolePrompt(
        {
          ...AUDITOR,
          avatar: { kind: 'portrait', index: 7 },
          version: 9,
          updatedAt: 0,
        },
        { inGroup: {} },
      ),
    ).toBe(first)
  })

  it('leaves out empty sections and memory that is switched off', () => {
    const bare: Contact = {
      ...AUDITOR,
      intro: '',
      domains: [],
      role: {
        mission: '',
        deliverable: '',
        playbook: '',
        boundaries: '',
        knowledge: [],
      },
      memory: { enabled: false },
    }
    expect(compileRolePrompt(bare, { memory: '不该出现' })).toBe(
      '# 身份\n\n你是「安全审计」，按下面这份岗位说明书工作。\n',
    )
    const quiet = compileRolePrompt(
      { ...bare, groupHabit: { speak: 'mentioned', length: 'detailed' } },
      { inGroup: {} },
    )
    expect(quiet).toContain('- 发言时机：只在被 @ 点名时发言')
    expect(quiet).toContain('- 篇幅：详细')
    expect(quiet).not.toContain('你在群聊')
    expect(quiet).not.toContain('## 群公告')
  })
})
