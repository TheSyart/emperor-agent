// GRP-04: the contact editor's state — the four ways a draft starts, the
// 「AI 起草」 marks, the five completeness rules, the character limits, the
// tool chips and what goes to Core when the user saves.
import { describe, expect, it } from 'vitest'
import type {
  AgentFileImport,
  BriefDraft,
  Contact,
  ContactTemplate,
} from '@emperor/core/api'
import {
  applyBrief,
  charHint,
  completeness,
  createInput,
  draftCopy,
  draftFromContact,
  draftFromImport,
  draftFromTemplate,
  draftInput,
  editSection,
  emptyDraft,
  freeName,
  playbookSteps,
  toggleTool,
  toolChips,
  updatePatch,
} from './contactEditorModel'

const PRESETS = {
  read_only: ['glob', 'grep', 'read', 'skill', 'todo_write'],
  research: [
    'glob',
    'grep',
    'read',
    'skill',
    'todo_write',
    'web_fetch',
    'web_search',
  ],
  writer: [
    'edit',
    'glob',
    'grep',
    'read',
    'skill',
    'todo_write',
    'web_fetch',
    'web_search',
    'write',
  ],
  engineer: [
    'bash',
    'edit',
    'glob',
    'grep',
    'job_kill',
    'job_list',
    'job_output',
    'read',
    'skill',
    'todo_write',
    'web_fetch',
    'web_search',
    'write',
  ],
  custom: [],
}

const TEMPLATE: ContactTemplate = {
  id: 'security-auditor',
  name: '安全审计',
  intro: '找出代码里的安全漏洞，给出可复现的证据和修法',
  domains: ['engineering', 'security'],
  tools: 'read_only',
  permission: 'read_only',
  speak: 'relevant',
  modelHint: 'reasoning',
  avatarTheme: 'engineering',
  avatar: 'AV-01-4',
  role: {
    mission: '审查改动中的安全问题。',
    deliverable: '问题清单。',
    playbook: '1. 弄清信任边界\n2. 沿数据流追\n3. 查密钥\n4. 看依赖',
    boundaries: '不改代码。',
    knowledge: [],
    trialTask: '审查 git-runner.ts 里新加的 diff 调用',
  },
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-reviewer00001',
    kind: 'local',
    name: '审稿人',
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: '代码与方案评审',
    domains: ['engineering'],
    role: {
      mission: '审查改动。',
      deliverable: '问题清单。',
      playbook: '1. 读改动\n2. 列问题',
      boundaries: '不改代码。',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 3,
    builtin: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('the four ways a draft starts (card test: 四种建法)', () => {
  it('从岗位模板: the template’s card, avatar and sample task', () => {
    const draft = draftFromTemplate(TEMPLATE, {
      contacts: [],
      globalPermission: 'workspace-write',
    })
    expect(draft).toMatchObject({
      name: '安全审计',
      intro: TEMPLATE.intro,
      domains: ['engineering', 'security'],
      templateId: 'security-auditor',
      avatar: { kind: 'library', id: 'AV-01-4' },
      role: {
        mission: '审查改动中的安全问题。',
        trialTask: TEMPLATE.role.trialTask,
      },
      capabilities: {
        model: 'inherit',
        tools: { preset: 'read_only' },
        permission: 'read_only',
      },
      groupHabit: { speak: 'relevant', length: 'brief' },
    })
    expect(draft.id).toBeUndefined()
  })

  it('从岗位模板: a free name, and never above the global permission', () => {
    const writer = {
      ...TEMPLATE,
      name: '写作者',
      tools: 'writer',
      permission: 'workspace_write',
    } as ContactTemplate
    const draft = draftFromTemplate(writer, {
      contacts: [contact({ name: '写作者' }), contact({ name: '写作者 2' })],
      globalPermission: 'read-only',
    })
    expect(draft.name).toBe('写作者 3')
    expect(draft.capabilities.permission).toBe('read_only')
  })

  it('说说你要什么人: fills the sections and marks each 「AI 起草」', () => {
    const brief: BriefDraft = {
      name: '审稿人',
      intro: '审 TypeScript 改动',
      domains: ['engineering'],
      role: {
        mission: '审查改动。',
        deliverable: '问题清单。',
        playbook: '1. 读\n2. 列',
        boundaries: '不改代码。',
        trialTask: '审查这段代码',
      },
      tools: 'writer',
      permission: 'workspace_write',
      speak: 'mentioned',
    }
    const { draft, drafted } = applyBrief(emptyDraft(), brief, [
      'identity',
      'mission',
      'playbook',
      'boundaries',
      'capabilities',
      'groupHabit',
    ])
    expect(draft).toMatchObject({
      name: '审稿人',
      role: { playbook: '1. 读\n2. 列', trialTask: '审查这段代码' },
      capabilities: {
        tools: { preset: 'writer' },
        permission: 'workspace_write',
      },
      groupHabit: { speak: 'mentioned' },
    })
    expect([...drafted].sort()).toEqual(
      [
        'boundaries',
        'capabilities',
        'groupHabit',
        'identity',
        'mission',
        'playbook',
      ].sort(),
    )
    // The avatar picked so far stays.
    expect(draft.avatar).toEqual(emptyDraft().avatar)
  })

  it('导入: the import’s fields, unsaved', () => {
    const imported: AgentFileImport = {
      draft: {
        name: 'reviewer',
        intro: 'Reviews code',
        domains: [],
        role: {
          mission: '',
          deliverable: '',
          playbook: '1. 读改动',
          boundaries: '',
          knowledge: [],
        },
        capabilities: {
          model: 'inherit',
          tools: { preset: 'custom', allow: ['bash', 'read'] },
          permission: 'workspace_write',
        },
        groupHabit: { speak: 'relevant', length: 'brief' },
      },
      tools: ['bash', 'read'],
      unknownTools: ['Task'],
      modelHint: 'opus',
      notes: ['这些工具没有对应的，没有导入：Task。'],
    }
    const draft = draftFromImport(imported, emptyDraft())
    expect(draft).toMatchObject({
      name: 'reviewer',
      role: { playbook: '1. 读改动' },
      capabilities: { tools: { preset: 'custom', allow: ['bash', 'read'] } },
    })
    expect(draft.id).toBeUndefined()
  })

  it('复制已有联系人: a copy under a free name, not the original', () => {
    const source = contact()
    const draft = draftCopy(source, [
      source,
      contact({ id: 'ct-x', name: '审稿人 副本' }),
    ])
    expect(draft.name).toBe('审稿人 副本 2')
    expect(draft.id).toBeUndefined()
    expect(draft.builtin).toBe(false)
    expect(draft.role).toEqual(source.role)
    expect(draft.role).not.toBe(source.role)
  })
})

describe('freeName', () => {
  it('numbers a taken name and fits the 24-character limit', () => {
    expect(freeName('编辑', [])).toBe('编辑')
    expect(freeName('编辑', [contact({ name: '编辑' })])).toBe('编辑 2')
    const long = '长'.repeat(24)
    expect(Array.from(freeName(long, [contact({ name: long })]))).toHaveLength(
      24,
    )
  })
})

describe('「AI 起草」 marks', () => {
  it('drops the mark of the section the user changes', () => {
    const drafted = new Set(['identity', 'mission', 'playbook'] as const)
    const next = editSection(drafted, 'mission')
    expect([...next].sort()).toEqual(['identity', 'playbook'])
    expect(editSection(next, 'knowledge')).toEqual(next)
  })
})

describe('completeness (card test: 完整度五条规则)', () => {
  const facts = {
    tools: PRESETS.read_only,
    globalPermission: 'workspace-write',
    trialRan: true,
  }

  it('passes all five for a finished card', () => {
    const items = completeness(draftFromContact(contact()), facts)
    expect(items.map((item) => [item.key, item.done])).toEqual([
      ['deliverable', true],
      ['playbook', true],
      ['boundaries', true],
      ['tools', true],
      ['trial', true],
    ])
  })

  it('wants a deliverable, two steps, boundaries and a trial', () => {
    const draft = draftFromContact(
      contact({
        role: {
          mission: '审查。',
          deliverable: ' ',
          playbook: '先看看再说',
          boundaries: '',
          knowledge: [],
        },
      }),
    )
    const items = completeness(draft, { ...facts, trialRan: false })
    expect(items.filter((item) => !item.done).map((item) => item.key)).toEqual([
      'deliverable',
      'playbook',
      'boundaries',
      'trial',
    ])
    for (const item of items) expect(item.label.length).toBeGreaterThan(0)
  })

  it('flags tools that write with a read-only permission (inherit counts as the global one)', () => {
    const writer = draftFromContact(
      contact({
        capabilities: {
          model: 'inherit',
          tools: { preset: 'writer' },
          permission: 'read_only',
        },
      }),
    )
    const tools = completeness(writer, {
      ...facts,
      tools: PRESETS.writer,
    }).find((item) => item.key === 'tools')!
    expect(tools.done).toBe(false)
    const inherit = {
      ...writer,
      capabilities: { ...writer.capabilities, permission: 'inherit' as const },
    }
    expect(
      completeness(inherit, {
        ...facts,
        tools: PRESETS.writer,
        globalPermission: 'workspace-write',
      }).find((item) => item.key === 'tools')!.done,
    ).toBe(true)
    expect(
      completeness(inherit, {
        ...facts,
        tools: PRESETS.writer,
        globalPermission: 'read-only',
      }).find((item) => item.key === 'tools')!.done,
    ).toBe(false)
  })

  it('counts numbered and bulleted steps', () => {
    expect(playbookSteps('1. 读\n2. 列')).toBe(2)
    expect(playbookSteps('1、读\n2）列\n- 查\n* 看\n• 写')).toBe(5)
    expect(playbookSteps('一段话，没有步骤。\n第二行')).toBe(0)
  })
})

describe('character limits (card test: 字数提示)', () => {
  it('counts a Chinese character as one and says when it is over', () => {
    expect(charHint('安全审计', 24)).toEqual({ text: '4 / 24', over: false })
    expect(charHint('长'.repeat(25), 24)).toEqual({
      text: '25 / 24 · 超过 1 字',
      over: true,
    })
  })
})

describe('tool chips', () => {
  it('shows the preset’s tools on, and toggles into allow and deny', () => {
    const draft = draftFromContact(contact())
    const chips = toolChips(draft.capabilities.tools, PRESETS)
    expect(
      chips
        .filter((chip) => chip.on)
        .map((chip) => chip.name)
        .sort(),
    ).toEqual(PRESETS.read_only)
    // Every tool a preset can hold has a chip.
    expect(chips.map((chip) => chip.name).sort()).toEqual(PRESETS.engineer)
    expect(chips.find((chip) => chip.name === 'read')!.label).toBe('读文件')
    const withBash = toggleTool(draft.capabilities.tools, 'bash', PRESETS)
    expect(withBash).toEqual({ preset: 'read_only', allow: ['bash'] })
    const withoutRead = toggleTool(withBash, 'read', PRESETS)
    expect(withoutRead).toEqual({
      preset: 'read_only',
      allow: ['bash'],
      deny: ['read'],
    })
    expect(toggleTool(withoutRead, 'read', PRESETS)).toEqual({
      preset: 'read_only',
      allow: ['bash'],
    })
    expect(toggleTool({ preset: 'custom' }, 'grep', PRESETS)).toEqual({
      preset: 'custom',
      allow: ['grep'],
    })
  })
})

describe('what goes to Core', () => {
  it('creates with every field and the template id', () => {
    const draft = draftFromTemplate(TEMPLATE, {
      contacts: [],
      globalPermission: 'workspace-write',
    })
    const input = createInput(draft)
    expect(input).toMatchObject({
      name: '安全审计',
      kind: 'local',
      templateId: 'security-auditor',
      avatar: { kind: 'library', id: 'AV-01-4' },
      role: { mission: '审查改动中的安全问题。' },
    })
    expect(input).not.toHaveProperty('id')
  })

  it('changes a builtin’s avatar and intro only', () => {
    const emperor = contact({
      id: 'ct-emperor',
      name: 'Emperor',
      builtin: true,
      avatar: { kind: 'mascot', pose: 'crown-head' },
    })
    const draft = { ...draftFromContact(emperor), intro: '新的简介' }
    expect(updatePatch(draft)).toEqual({
      avatar: { kind: 'mascot', pose: 'crown-head' },
      intro: '新的简介',
    })
  })

  it('sends the trial bench and the preview the draft with the saved id', () => {
    const draft = draftFromContact(contact())
    expect(draftInput(draft)).toMatchObject({
      id: 'ct-reviewer00001',
      name: '审稿人',
    })
    expect(draftInput(emptyDraft())).not.toHaveProperty('id')
  })
})
