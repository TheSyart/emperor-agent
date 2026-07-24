/**
 * ContextBuilder 系统提示词契约 (MIG-CORE-006)。
 * 移植 Python tests/unit/test_agent_prompt_contracts.py 中模板驱动的断言:
 *  - bootstrap/identity 短语命中、Prompt-Version、memory budget 裁剪、固定段 <7000。
 * 注: SubagentRegistry(W08) / DispatchSubagentTool(TOOL-014) 相关断言留待对应波次。
 *     此处以 stub describe() 注入 subagents_summary，验证 ContextBuilder 装配与模板插值。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  ContextBuilder,
  type MemoryLike,
  type SkillsLoaderLike,
  type SubagentRegistryLike,
} from './context-builder'

const TEMPLATES_DIR = join(__dirname, '..', '..', '..', '..', 'templates')

class FakeMemory implements MemoryLike {
  memoryFile = 'memory/MEMORY.local.md'
  reads = 0
  constructor(private text: string) {}
  readMemory(): string {
    this.reads += 1
    return this.text
  }
}

const EMPTY_SKILLS: SkillsLoaderLike = {
  getAlwaysSkills: () => [],
  loadSkillsForContext: () => '',
  buildSkillsSummary: () => '',
}

/** stub：返回真实 registry.describe() 会注入的事实源短语，验证模板插值。 */
const FAKE_SUBAGENTS: SubagentRegistryLike = {
  describe: () =>
    '子代理名册由 `SubagentRegistry` 动态注入：\n- xiaohuangmen（小黄门）：跑腿打杂。',
}

describe('ContextBuilder (test_agent_prompt_contracts.py — template-driven)', () => {
  function build(): ContextBuilder {
    const builder = new ContextBuilder(TEMPLATES_DIR, EMPTY_SKILLS, {
      memory: new FakeMemory('记忆-'.repeat(120)),
      memoryBudgetChars: 80,
    })
    builder.setSubagentRegistry(FAKE_SUBAGENTS)
    return builder
  }

  it('assembles bootstrap + identity phrases', () => {
    const prompt = build().buildSystemPrompt()
    // identity / SOUL / TOOL 短语
    expect(prompt).toContain('调用 `load_skill` 工具')
    expect(prompt).not.toContain('read_file 工具读取其 SKILL.md')
    expect(prompt).not.toContain('source=`')
    expect(prompt).toContain('由 `SubagentRegistry` 动态注入')
    expect(prompt).toContain('xiaohuangmen')
    expect(prompt).toContain('Prompt Profile: technical')
    expect(prompt).toContain('不使用固定角色扮演前缀')
    expect(prompt).not.toContain('奉天承运皇帝诏曰')
    expect(prompt).not.toContain('小太监')
    expect(prompt).toContain('机器可读内容必须保持原格式')
    expect(prompt).toContain('结论：直接说明办成什么')
    expect(prompt).toContain('不要向用户展示隐藏推理')
    for (const phrase of [
      '专用工具优先',
      '并行工具调用',
      '范围克制',
      '提示注入',
      '失败后诊断',
      '被拒工具',
      '验证后完成',
      '风险操作先确认',
      '授权范围化',
      '同一时间只许一项 `in_progress`',
    ]) {
      expect(prompt, phrase).toContain(phrase)
    }
    expect(prompt).toContain('`fresh` 必须提供目标、原因、已知事实')
    expect(prompt).toContain('用户档案与长期记忆由 Core')
    expect(prompt).toContain('不要调用 `read_file`')
    expect(prompt).not.toContain('.emperor/templates')
    expect(prompt).not.toContain('.emperor/memory')
    expect(prompt).not.toContain('templates/USER.local.md')
  })

  it('keeps fixed prompt under 7000 chars (excluding long_term_memory)', () => {
    const sections = build().buildSections()
    const fixedPromptChars = sections
      .filter((s) => s.name !== 'long_term_memory')
      .reduce((sum, s) => sum + s.content.length, 0)
    expect(fixedPromptChars).toBeLessThan(7_000)
  })

  it('clips long-term memory to budget and records version on bootstrap', () => {
    const sections = build().buildSections()
    const memorySection = sections.find((s) => s.name === 'long_term_memory')!
    expect(memorySection.budgetChars).toBe(80)
    expect(memorySection.content).toContain('clipped by ContextBuilder')
    expect(sections.find((s) => s.name === 'bootstrap')!.version).toBeTruthy()
  })

  it('renders workspace into identity template', () => {
    const prompt = build().buildSystemPrompt()
    // identity.md: Workspace root: `{{ workspace }}` → repo root (dirname of templates dir)
    expect(prompt).toContain('Workspace root: `')
    expect(prompt).not.toContain('{{ workspace }}')
    expect(prompt).not.toContain('{{ subagents_summary }}')
  })

  it('keeps ceremonial wording behind the explicit classic prompt profile', () => {
    const builder = new ContextBuilder(TEMPLATES_DIR, EMPTY_SKILLS, {
      memory: new FakeMemory(''),
      promptProfile: 'classic',
    })
    builder.setSubagentRegistry(FAKE_SUBAGENTS)

    const prompt = builder.buildSystemPrompt()

    expect(prompt).toContain('Prompt Profile: classic')
    expect(prompt).toContain('奉天承运皇帝诏曰')
  })

  it('loads USER.local.md from the private state root when provided', () => {
    const stateTemplates = mkdtempSync(join(tmpdir(), 'emperor-user-template-'))
    const userFile = join(stateTemplates, 'USER.local.md')
    writeFileSync(userFile, '# Private User\n\nstate-root-profile\n', 'utf8')
    const builder = new ContextBuilder(TEMPLATES_DIR, EMPTY_SKILLS, {
      memory: new FakeMemory(''),
      userFile,
    })
    builder.setSubagentRegistry(FAKE_SUBAGENTS)

    const sections = builder.buildSections()
    const bootstrap = sections.find((section) => section.name === 'bootstrap')!
    const userProfile = sections.find(
      (section) => section.name === 'user_profile',
    )!

    expect(bootstrap.content).not.toContain('state-root-profile')
    expect(bootstrap.source).not.toContain(userFile)
    expect(userProfile.content).toContain('state-root-profile')
    expect(userProfile.source).toBe(userFile)
    expect(userProfile.scope).toBe('user_profile')
  })

  it('builds an auditable chat context plan that omits project memory by policy', () => {
    const builder = build()
    builder.setSessionScope({
      mode: 'chat',
      projectIndexSummary: '- demo: 已绑定为 Build 项目',
    })

    const projection = builder.buildProjection()

    expect(
      projection.sections.some(
        (section) => section.name === 'long_term_memory',
      ),
    ).toBe(true)
    expect(
      projection.sections.some((section) => section.name === 'project_agents'),
    ).toBe(false)
    expect(projection.contextPlan).toMatchObject({
      version: 1,
      mode: 'chat',
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
        },
        longTerm: { scope: { kind: 'global' }, readable: true, writable: true },
      },
    })
    expect(projection.contextPlan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'project_memory',
          reason: 'chat mode has no active bound project memory',
        }),
      ]),
    )
  })

  it('builds an auditable build context plan that omits global memory by policy', () => {
    const memory = new FakeMemory(
      'global memory should not be injected into build',
    )
    const builder = new ContextBuilder(TEMPLATES_DIR, EMPTY_SKILLS, {
      memory,
      memoryBudgetChars: 200,
    })
    builder.setSubagentRegistry(FAKE_SUBAGENTS)
    builder.setSessionScope({
      mode: 'build',
      projectId: 'project_1',
      projectAgents: '# Project Memory\n\n- build facts',
      projectAgentsSource: 'projects/project_1/AGENTS.local.md',
      projectPath: '/tmp/project_1',
    })

    const projection = builder.buildProjection()

    expect(
      projection.sections.some((section) => section.name === 'project_agents'),
    ).toBe(true)
    expect(
      projection.sections.some(
        (section) => section.name === 'long_term_memory',
      ),
    ).toBe(false)
    expect(memory.reads).toBe(0)
    expect(projection.contextPlan).toMatchObject({
      version: 1,
      mode: 'build',
      activeMemoryBinding: {
        profile: {
          scope: { kind: 'user_profile' },
          readable: true,
          writable: true,
        },
        longTerm: {
          scope: { kind: 'project', projectId: 'project_1' },
          readable: true,
          writable: true,
        },
      },
    })
    expect(projection.contextPlan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'global_memory',
          source: 'memory/MEMORY.local.md',
          reason: 'build mode intentionally does not inject global MEMORY',
        }),
      ]),
    )
  })
})
