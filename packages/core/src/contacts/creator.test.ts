import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROLE_CREATOR_CONTACT_ID,
  RoleCreatorService,
  type RoleCreatorMcpServer,
  type RoleCreatorSkill,
} from './creator'
import { ContactStore } from './store'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')
const TOOL_NAMES = [
  'ask_user_question',
  'bash',
  'edit',
  'glob',
  'grep',
  'read',
  'skill',
  'todo_write',
  'web_fetch',
  'web_search',
  'write',
]

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'emperor-role-creator-'))
  const contacts = new ContactStore({
    stateRoot,
    templatesDir: TEMPLATES_DIR,
    toolNames: () => TOOL_NAMES,
    globalPermission: () => 'workspace-write',
  })
  const skills: RoleCreatorSkill[] = [
    { name: 'review', sourceId: 'user', description: '方案评审' },
  ]
  const servers: RoleCreatorMcpServer[] = [
    { serverId: 'docs', state: 'ready', tools: ['search', 'fetch'] },
  ]
  const service = new RoleCreatorService({
    contacts,
    skills: () => skills,
    mcp: () => servers,
  })
  return { stateRoot, contacts, service, skills, servers }
}

const ROLE = {
  mission: '发现方案中的风险和遗漏。',
  deliverable: '按严重程度列出问题，并给出明确建议。',
  playbook: '1. 核对目标\n2. 检查风险\n3. 给出建议',
  boundaries: '不代替用户做决定；不确定处明确标注。',
}

describe('role creator drafts', () => {
  it('validates a complete draft without saving it', async () => {
    const { contacts, service, stateRoot } = fixture()
    const before = await contacts.list()
    const result = await service.draft({
      action: 'create',
      draft: {
        name: '方案评审员',
        intro: '发现方案风险，给出取舍建议',
        domains: ['product'],
        role: ROLE,
        avatar: { kind: 'library', id: 'AV-05-1' },
        capabilities: {
          model: 'inherit',
          tools: { preset: 'read_only' },
          permission: 'read_only',
        },
        groupHabit: { speak: 'relevant', length: 'brief' },
      },
    })

    expect(result).toMatchObject({
      kind: 'contact-role-draft',
      action: 'create',
      draft: {
        name: '方案评审员',
        avatar: { kind: 'library', id: 'AV-05-1' },
      },
    })
    expect(result.draft.role?.trialTask).toBeUndefined()
    expect(await contacts.list()).toEqual(before)
    expect(
      readFileSync(join(stateRoot, 'contacts', 'contacts.json'), 'utf8'),
    ).not.toContain('方案评审员')
  })

  it('resolves installed Skills and expands each MCP service to its current tools', async () => {
    const { service, servers } = await fixture()
    const result = await service.draft({
      action: 'create',
      draft: {
        name: '资料评审员',
        role: ROLE,
        skills: ['review'],
        mcp: ['docs'],
      },
    })
    expect(result.draft.skills).toEqual([
      { id: expect.stringMatching(/^sk-/), sourceId: 'user', name: 'review' },
    ])
    expect(result.draft.mcp).toEqual([
      { serverId: 'docs', toolNames: ['search', 'fetch'] },
    ])

    // A later tool appears only in a newly selected service, never in this draft.
    servers[0]!.tools.push('delete')
    expect(result.draft.mcp?.[0]?.toolNames).toEqual(['search', 'fetch'])
    expect(
      (
        await service.draft({
          action: 'create',
          draft: { name: '另一个评审员', role: ROLE, mcp: ['docs'] },
        })
      ).draft.mcp?.[0]?.toolNames,
    ).toEqual(['search', 'fetch', 'delete'])
  })

  it('rejects unknown Skills, MCP services and unavailable services', async () => {
    const { service, servers } = fixture()
    await expect(
      service.draft({
        action: 'create',
        draft: { name: 'A', role: ROLE, skills: ['missing'] },
      }),
    ).rejects.toThrow('没有这些 Skill')
    await expect(
      service.draft({
        action: 'create',
        draft: { name: 'A', role: ROLE, mcp: ['missing'] },
      }),
    ).rejects.toThrow('没有这些 MCP 服务')
    servers[0]!.state = 'failed'
    await expect(
      service.draft({
        action: 'create',
        draft: { name: 'A', role: ROLE, mcp: ['docs'] },
      }),
    ).rejects.toThrow('当前不可用')
  })

  it('rejects duplicate names before a confirmation card is offered', async () => {
    const { contacts, service } = fixture()
    await contacts.create({ name: '方案评审员', role: ROLE })
    await expect(
      service.draft({
        action: 'create',
        draft: { name: '方案评审员', role: ROLE },
      }),
    ).rejects.toThrow('已经有叫')
  })

  it('builds an edit from a unique id and a patch, preserving every other field', async () => {
    const { contacts, service } = fixture()
    const saved = await contacts.create({
      name: '方案评审员',
      intro: '旧简介',
      domains: ['product'],
      role: ROLE,
      knowledge: [
        {
          id: 'kr-old',
          kind: 'note',
          title: '口径',
          text: '先事实后建议',
          use: 'pinned',
        },
      ],
      skills: [],
      mcp: [],
      capabilities: {
        model: 'inherit',
        tools: { preset: 'research' },
        permission: 'read_only',
      },
      memory: { enabled: false },
    })
    const before = await contacts.list()
    const result = await service.draft({
      action: 'edit',
      targetId: saved.id,
      patch: { intro: '新简介', role: { boundaries: '只评审，不执行。' } },
    })

    expect(result.action).toBe('edit')
    expect(result.targetId).toBe(saved.id)
    expect(result.patch).toEqual({
      intro: '新简介',
      role: { boundaries: '只评审，不执行。' },
    })
    expect(result.draft).toMatchObject({
      id: saved.id,
      name: saved.name,
      intro: '新简介',
      knowledge: saved.knowledge,
      capabilities: saved.capabilities,
      memory: { enabled: false },
      role: { ...ROLE, boundaries: '只评审，不执行。' },
    })
    expect(await contacts.list()).toEqual(before)
  })

  it('requires an exact non-builtin target id and a non-empty patch', async () => {
    const { contacts, service } = fixture()
    const saved = await contacts.create({ name: '方案评审员', role: ROLE })
    await expect(
      service.draft({
        action: 'edit',
        targetId: saved.name,
        patch: { intro: 'x' },
      }),
    ).rejects.toThrow('唯一联系人编号')
    await expect(
      service.draft({ action: 'edit', targetId: saved.id, patch: {} }),
    ).rejects.toThrow('修改内容不能为空')
    for (const targetId of [ROLE_CREATOR_CONTACT_ID, 'ct-emperor', 'ct-codex'])
      await expect(
        service.draft({ action: 'edit', targetId, patch: { intro: '越权' } }),
      ).rejects.toThrow('内置联系人')
  })

  it('never expands a patch into write or executor permissions by itself', async () => {
    const { service } = fixture()
    await expect(
      service.draft({
        action: 'create',
        draft: {
          name: '越权角色',
          role: ROLE,
          capabilities: {
            model: 'inherit',
            tools: { preset: 'custom', allow: ['not_installed'] },
            permission: 'workspace_write',
          },
        },
      }),
    ).rejects.toThrow('没有这些工具')
  })
})
