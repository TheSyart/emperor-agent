/**
 * 系统提示词构建 ContextBuilder (MIG-CORE-006)。对齐 Python `agent/context.py`。
 * bootstrap(SOUL/TOOL/USER) + identity + memory + skills 拼装；段以 \n\n---\n\n 连接。
 * jinja → 手写插值（仅 workspace / subagents_summary / skills_summary 三个变量）。
 * skills/subagent/memory 以注入接口给入（完整实现来自各自波次）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizePromptProfile, type PromptProfile } from '../config/local-config'
import type { PromptContextPlan } from '../prompts/manifest'
import { ContextAssembler } from '../context/assembler'
import { ContextPlanner } from '../context/planner'
import { ContextPolicyRegistry } from '../context/policy'

const DEFAULT_MEMORY_BUDGET_CHARS = 12_000

export interface ContextSection {
  name: string
  content: string
  source: string
  priority: number
  budgetChars: number | null
  version: string | null
  scope?: string | null
}

export interface ContextProjection {
  sections: ContextSection[]
  contextPlan: PromptContextPlan
  prompt: string
}

/** 完整 SkillsLoader 的最小表面（W04/技能波次提供实现）。 */
export interface SkillsLoaderLike {
  getAlwaysSkills(): string[]
  loadSkillsForContext(names: string[]): string
  buildSkillsSummary(opts?: { exclude?: Set<string> }): string
}

/** SubagentRegistry 的最小表面（W08 提供实现）。 */
export interface SubagentRegistryLike {
  describe(): string
}

/** MemoryStore 的最小表面（W06 提供实现）。 */
export interface MemoryLike {
  readMemory(): string
  memoryFile?: string
  memoryDir?: string
}

export class ContextBuilder {
  private static readonly BOOTSTRAP_FILES = ['SOUL.md', 'TOOL.md']

  readonly docsDir: string
  readonly skills: SkillsLoaderLike
  readonly memory: MemoryLike | null
  readonly memoryBudgetChars: number
  readonly userFile: string | null
  readonly promptProfile: PromptProfile
  readonly policyRegistry = new ContextPolicyRegistry()
  subagentRegistry: SubagentRegistryLike | null = null
  sessionMode: 'chat' | 'build' = 'chat'
  projectAgents = ''
  projectAgentsSource = ''
  projectId = ''
  projectPath = ''
  projectIndexSummary = ''
  compactionOmittedRanges: Array<{ fromSeq: number; toSeq: number; compactionId?: string | null; targetScopes?: string[] }> = []

  constructor(
    docsDir: string,
    skillsLoader: SkillsLoaderLike,
    opts?: { memory?: MemoryLike | null; memoryBudgetChars?: number; userFile?: string | null; promptProfile?: PromptProfile | string | null },
  ) {
    this.docsDir = docsDir
    this.skills = skillsLoader
    this.memory = opts?.memory ?? null
    this.memoryBudgetChars = opts?.memoryBudgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS
    this.userFile = opts?.userFile ?? null
    this.promptProfile = normalizePromptProfile(opts?.promptProfile)
  }

  setSubagentRegistry(subagentRegistry: SubagentRegistryLike | null): void {
    this.subagentRegistry = subagentRegistry
  }

  setSessionScope(opts?: {
    mode?: string
    projectId?: string
    projectAgents?: string
    projectAgentsSource?: string
    projectPath?: string
    projectIndexSummary?: string
    compactionOmittedRanges?: Array<{ fromSeq: number; toSeq: number; compactionId?: string | null; targetScopes?: string[] }>
  }): void {
    this.sessionMode = opts?.mode === 'build' ? 'build' : 'chat'
    this.projectId = String(opts?.projectId ?? '').trim()
    this.projectAgents = String(opts?.projectAgents ?? '').trim()
    this.projectAgentsSource = String(opts?.projectAgentsSource ?? '').trim()
    this.projectPath = String(opts?.projectPath ?? '').trim()
    this.projectIndexSummary = String(opts?.projectIndexSummary ?? '').trim()
    this.compactionOmittedRanges = (opts?.compactionOmittedRanges ?? [])
      .map((range) => ({
        fromSeq: Math.max(1, Math.trunc(Number(range.fromSeq) || 0)),
        toSeq: Math.max(1, Math.trunc(Number(range.toSeq) || 0)),
        compactionId: range.compactionId ?? null,
        targetScopes: range.targetScopes ?? [],
      }))
      .filter((range) => range.toSeq >= range.fromSeq)
  }

  renderTemplate(name: string, vars: Record<string, string>): string {
    const path = join(this.docsDir, 'agent', name)
    if (!existsSync(path)) return ''
    try {
      let text = readFileSync(path, 'utf8')
      // jinja {{ var }} → 插值（仅三个已知变量；容忍任意空白）。
      for (const [key, value] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
      }
      return text
    } catch {
      return ''
    }
  }

  buildSystemPrompt(): string {
    return this.buildProjection().prompt
  }

  buildProjection(): ContextProjection {
    const sections = this.buildSections()
    const contextPlan = this.buildContextPlan(sections)
    return {
      sections,
      contextPlan,
      prompt: renderContextSections(sections, contextPlan),
    }
  }

  buildSections(): ContextSection[] {
    const sections: ContextSection[] = []
    const policy = this.policyRegistry.policyForMode(this.sessionMode)

    const bootstrapParts: string[] = []
    const versions: string[] = []
    for (const name of ContextBuilder.BOOTSTRAP_FILES) {
      const path = this.bootstrapPath(name)
      if (!existsSync(path)) continue
      const text = readFileSync(path, 'utf8').trim()
      bootstrapParts.push(text)
      const version = promptVersion(text)
      if (version) versions.push(`${name}:${version}`)
    }
    const bootstrap = bootstrapParts.join('\n\n')
    if (bootstrap) {
      sections.push({
        name: 'bootstrap',
        content: bootstrap,
        source: bootstrapSource(),
        priority: 100,
        budgetChars: null,
        version: versions.join(', ') || null,
        scope: 'prompt',
      })
    }

    const userProfilePath = this.bootstrapPath('USER.md')
    if (existsSync(userProfilePath)) {
      const userProfile = readFileSync(userProfilePath, 'utf8').trim()
      if (userProfile) {
        sections.push({
          name: 'user_profile',
          content: userProfile,
          source: userProfilePath,
          priority: 98,
          budgetChars: null,
          version: promptVersion(userProfile),
          scope: 'user_profile',
        })
      }
    }

    sections.push({
      name: 'persona',
      content: profilePrompt(this.promptProfile),
      source: `prompt-profile:${this.promptProfile}`,
      priority: 95,
      budgetChars: null,
      version: 'prompt-profile-v1',
      scope: 'prompt',
    })

    const workspace = this.policyRegistry.includes(policy, 'project_path') && this.projectPath ? this.projectPath : dirname(this.docsDir)
    const identity = this.renderTemplate('identity.md', { workspace, subagents_summary: this.subagentsSummary() })
    if (identity) {
      sections.push({
        name: 'identity',
        content: identity,
        source: 'templates/agent/identity.md',
        priority: 90,
        budgetChars: null,
        version: promptVersion(identity),
        scope: 'runtime',
      })
    }

    if (this.policyRegistry.includes(policy, 'project_memory') && this.projectAgents) {
      sections.push({
        name: 'project_agents',
        content:
          '# Project State\n\n' +
          `Project path: ${this.projectPath || '(unknown)'}\n\n` +
          `${clipText(this.projectAgents, this.memoryBudgetChars, 'Project State')}`,
        source: this.projectAgentsSource || 'projects/<project-id>/AGENTS.local.md',
        priority: 85,
        budgetChars: this.memoryBudgetChars,
        version: null,
        scope: 'project',
      })
    }

    if (this.policyRegistry.includes(policy, 'global_memory') && this.memory) {
      const memory = this.memory.readMemory().trim()
      if (memory) {
        const budgeted = clipText(memory, this.memoryBudgetChars, 'Long-term Memory')
        sections.push({
          name: 'long_term_memory',
          content: `# Long-term Memory\n\n${budgeted}`,
          source: String(this.memory.memoryFile ?? 'memory'),
          priority: 80,
          budgetChars: this.memoryBudgetChars,
          version: null,
          scope: 'global',
        })
      }
    }

    if (this.policyRegistry.includes(policy, 'project_index') && this.projectIndexSummary) {
      sections.push({
        name: 'project_index_summary',
        content: `# Project Index Summary\n\n${this.projectIndexSummary}`,
        source: 'projects/index.json',
        priority: 75,
        budgetChars: null,
        version: null,
        scope: 'project_index',
      })
    }

    const alwaysSkills = this.skills.getAlwaysSkills()
    if (alwaysSkills.length) {
      const alwaysContent = this.skills.loadSkillsForContext(alwaysSkills)
      if (alwaysContent) {
        sections.push({
          name: 'active_skills',
          content: `# Active Skills\n\n${alwaysContent}`,
          source: 'skills/*/SKILL.md',
          priority: 70,
          budgetChars: null,
          version: null,
          scope: 'skills',
        })
      }
    }

    const skillsSummary = this.skills.buildSkillsSummary({ exclude: new Set(alwaysSkills) })
    if (skillsSummary) {
      const skillsSection = this.renderTemplate('skills_section.md', { skills_summary: skillsSummary })
      sections.push({
        name: 'skills_summary',
        content: skillsSection,
        source: 'templates/agent/skills_section.md',
        priority: 60,
        budgetChars: null,
        version: promptVersion(skillsSection),
        scope: 'skills',
      })
    }

    return sections
  }

  private buildContextPlan(sections: ContextSection[]): PromptContextPlan {
    return new ContextPlanner().plan({
      mode: this.sessionMode,
      sections,
      projectId: this.projectId,
      memoryFile: this.memory?.memoryFile ?? 'memory/MEMORY.local.md',
      userFile: this.userFile,
      projectMemoryFile: this.projectAgentsSource || (this.projectId ? `projects/${this.projectId}/AGENTS.local.md` : null),
      policy: this.policyRegistry.policyForMode(this.sessionMode),
      compactionOmittedRanges: this.compactionOmittedRanges,
    })
  }

  private bootstrapPath(name: string): string {
    if (name === 'USER.md') {
      if (this.userFile && existsSync(this.userFile)) return this.userFile
      const init = join(this.docsDir, 'init', 'USER.md')
      if (existsSync(init)) return init
    }
    return join(this.docsDir, name)
  }

  private subagentsSummary(): string {
    if (this.subagentRegistry === null) return '(subagent registry not yet attached)'
    return this.subagentRegistry.describe()
  }
}

function bootstrapSource(): string {
  return 'templates/SOUL.md+templates/TOOL.md'
}

function profilePrompt(profile: PromptProfile): string {
  if (profile === 'classic') {
    return [
      '# Prompt Profile: classic',
      '',
      '- 普通自然语言最终回复可以使用轻量宫廷口吻。',
      '- 面向用户的普通闲聊或轻量总结可使用固定前缀"奉天承运皇帝诏曰"。',
      '- 机器可读输出、Ask/Plan 协议、错误诊断、工具参数、代码、提交信息和测试输出不得使用角色口吻。',
    ].join('\n')
  }
  if (profile === 'neutral') {
    return [
      '# Prompt Profile: neutral',
      '',
      '- 默认使用自然、克制、礼貌的中文。',
      '- 不使用固定角色扮演前缀。',
      '- 错误诊断、权限提示、Ask/Plan 协议和工具事件保持原始结构。',
    ].join('\n')
  }
  return [
    '# Prompt Profile: technical',
    '',
    '- 默认使用直接、准确、技术导向的中文。',
    '- 不使用固定角色扮演前缀。',
    '- 工程、排障、内部错误、权限、Ask/Plan 协议、工具事件和诊断信息必须保持清晰结构，不加入角色扮演措辞。',
  ].join('\n')
}

export function renderContextSections(sections: ContextSection[], contextPlan?: PromptContextPlan | null): string {
  return new ContextAssembler().renderSystemPrompt(sections, contextPlan)
}

function promptVersion(text: string): string | null {
  const match = /^Prompt-Version:\s*(.+)$/m.exec(text)
  return match ? match[1]!.trim() : null
}

function clipText(text: string, budgetChars: number, label: string): string {
  if (budgetChars <= 0 || text.length <= budgetChars) return text
  const headBudget = Math.max(1, Math.trunc(budgetChars * 0.68))
  const tailBudget = Math.max(1, budgetChars - headBudget)
  const omitted = text.length - headBudget - tailBudget
  return (
    `${text.slice(0, headBudget).replace(/\s+$/, '')}\n\n` +
    `[${label} clipped by ContextBuilder: ${omitted} chars omitted]\n\n` +
    `${text.slice(text.length - tailBudget).replace(/^\s+/, '')}`
  )
}
