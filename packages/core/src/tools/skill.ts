import { Tool, type ToolExecutionContext, type ToolResult } from './base'
import { S, toolParamsSchema } from './schema'

export interface SkillsLoader {
  getContent(name: string): string | null
  resolve?(name: string): ResolvedSkill | null
  summary(): string
}

export interface ResolvedSkill {
  name: string
  root: string
  skillFile: string
  content: string
  source: 'project' | 'user' | 'plugin' | 'builtin'
  readOnly: boolean
  status: string
  frontmatter: Record<string, unknown>
}

export function renderResolvedSkill(skill: ResolvedSkill, args = ''): string {
  const skillArgs = String(args).trim()
  const content = skill.content
    .replaceAll('{{skill_dir}}', skill.root)
    .replaceAll('${EMPEROR_SKILL_DIR}', skill.root)
    // Compatibility for third-party Claude Skills; it does not change identity.
    .replaceAll('${CLAUDE_SKILL_DIR}', skill.root)
  return [
    '<skill-context>',
    `Name: ${skill.name}`,
    `Base directory: ${skill.root}`,
    `Source: ${skill.source}`,
    `Status: ${skill.status}`,
    `Read-only: ${skill.readOnly}`,
    '</skill-context>',
    '',
    '<skill-instructions>',
    content,
    '</skill-instructions>',
    ...(skillArgs ? ['', '<skill-args>', skillArgs, '</skill-args>'] : []),
  ].join('\n')
}

export function resolvedSkillAllowedTools(
  frontmatter: Record<string, unknown>,
): string[] | null {
  const metadata = record(frontmatter.metadata)
  const emperor = record(metadata.emperor)
  const command = record(emperor.command)
  const raw =
    frontmatter['allowed-tools'] ??
    frontmatter.allowed_tools ??
    command.allowed_tools ??
    command.allowedTools
  if (raw === undefined) return null
  const values = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((value) => value.trim())
  return [
    ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  ]
}

export function resolvedSkillRequiresExternalEvidence(
  skill: ResolvedSkill,
): boolean {
  const description = String(skill.frontmatter.description ?? '')
  const tools = resolvedSkillAllowedTools(skill.frontmatter) ?? []
  return (
    skill.name === 'agent-reach' ||
    tools.some((tool) => ['web_fetch', 'web_search'].includes(tool)) ||
    /(?:internet|web|online|search|research|联网|网络|搜索|调研)/i.test(
      description,
    )
  )
}

export type SkillsLoaderProvider =
  SkillsLoader | ((sessionId?: string | null) => SkillsLoader | null)

/** Loads an already-resolved Skill. Installation and creation use normal tools. */
export class SkillTool extends Tool {
  override name = 'Skill'
  override description =
    'Load an already available Skill by name. Use this when the user selected a Skill or the task clearly matches one. ' +
    'This tool does not install Skills or dependencies; report a missing Skill instead of inventing its contents.'
  override parameters = toolParamsSchema(
    {
      skill: S('Skill name'),
      args: S('Optional arguments passed to the Skill instructions'),
    },
    ['skill'],
  )
  override readOnly = true
  override evidencePolicy = 'forbidden' as const

  constructor(private readonly loaderProvider: SkillsLoaderProvider | null) {
    super()
  }

  async execute(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
  ): Promise<string | ToolResult> {
    const name = String(args.skill ?? '').trim()
    const loader =
      typeof this.loaderProvider === 'function'
        ? this.loaderProvider(ctx?.sessionId)
        : this.loaderProvider
    if (!loader) return '[ERR] no skills loader configured'
    const skillArgs = String(args.args ?? '').trim()
    const resolved = loader.resolve?.(name) ?? null
    if (resolved) {
      const content = renderResolvedSkill(resolved, skillArgs)
      return {
        modelContent: content,
        displaySummary: `Loaded Skill: ${resolved.name}`,
        rawContent: content,
        artifacts: [],
        metadata: {
          tool: 'Skill',
          outcome: 'success',
          skill_name: resolved.name,
          skill_root: resolved.root,
          skill_source: resolved.source,
          skill_read_only: resolved.readOnly,
          skill_allowed_tools: resolvedSkillAllowedTools(resolved.frontmatter),
          requires_external_evidence:
            resolvedSkillRequiresExternalEvidence(resolved),
        },
        isError: false,
      }
    }
    const content = loader.getContent(name)
    if (!content) return `[ERR] skill "${name}" not found`
    return skillArgs
      ? `${content}\n\n<skill-args>\n${skillArgs}\n</skill-args>`
      : content
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
