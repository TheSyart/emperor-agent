import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExtensionResolver,
  applyAgentSessionPolicy,
  type AgentSessionPolicy,
  type ExtensionSnapshot,
  type ExtensionSourceInput,
  type ResolvedAgentDefinition,
} from '../extensions/resolver'
import type { SubagentSpec } from './spec'

const SOURCE_MODULE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))

export interface SkillsSummaryProvider {
  buildSkillsSummary?: () => string
  summary?: () => string
}

export interface SubagentRegistryOptions {
  userSourceRoot?: string | null
  additionalSources?: ExtensionSourceInput[]
  sessionPolicy?: AgentSessionPolicy | null
}

export class SubagentRegistry {
  readonly templatesDir: string
  private readonly skillsLoader: SkillsSummaryProvider | null
  private readonly specs = new Map<string, SubagentSpec>()
  private readonly extensionSnapshot: ExtensionSnapshot

  constructor(
    templatesDir: string,
    skillsLoader?: SkillsSummaryProvider | null,
    opts: SubagentRegistryOptions = {},
  ) {
    this.templatesDir = resolveBuiltinAgentRoot(templatesDir)
    this.skillsLoader = skillsLoader ?? null
    const userSource = opts.userSourceRoot
      ? userAgentSource(opts.userSourceRoot)
      : null
    this.extensionSnapshot = new ExtensionResolver({
      sources: [
        {
          id: 'emperor-builtin-agents',
          kind: 'builtin',
          root: this.templatesDir,
          manifests: ['agents.json'],
          trusted: true,
          readOnly: true,
        },
        ...(userSource ? [userSource] : []),
        ...(opts.additionalSources ?? []),
      ],
    }).resolve()
    this.loadAll(opts.sessionPolicy ?? null)
  }

  resolveName(name: string): string {
    return this.extensionSnapshot.aliases[name] ?? name
  }

  get(name: string): SubagentSpec | null {
    return this.specs.get(this.resolveName(name)) ?? null
  }

  names(opts: { includeAliases?: boolean } = {}): string[] {
    const names = new Set(this.specs.keys())
    if (opts.includeAliases) {
      for (const alias of Object.keys(this.extensionSnapshot.aliases))
        names.add(alias)
    }
    return [...names].sort()
  }

  aliases(): Record<string, string> {
    return { ...this.extensionSnapshot.aliases }
  }

  snapshot(): ExtensionSnapshot {
    return this.extensionSnapshot
  }

  describe(): string {
    const lines = [...this.specs.values()].map(
      (spec) => `  - ${spec.name}: ${spec.description}`,
    )
    const aliasText = Object.entries(this.extensionSnapshot.aliases)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} -> ${v}`)
      .join(', ')
    if (aliasText) lines.push(`  - 兼容别名: ${aliasText}`)
    return lines.join('\n')
  }

  private loadAll(sessionPolicy: AgentSessionPolicy | null): void {
    for (const resolved of this.extensionSnapshot.agents) {
      const definition = sessionPolicy
        ? applyAgentSessionPolicy(resolved.definition, sessionPolicy)
        : resolved.definition
      const systemPrompt = this.withSkillsSummary(
        resolved,
        definition.tools.allow,
      )
      this.specs.set(definition.name, {
        name: definition.name,
        description: definition.description,
        systemPrompt,
        toolNames: [...definition.tools.allow],
        maxTurns: definition.completion.maxTurns,
        planReadonlyExplorer: definition.delegation.planReadonlyExplorer,
        definition,
        source: resolved.source,
        revision: resolved.revision,
      })
    }
  }

  private withSkillsSummary(
    resolved: ResolvedAgentDefinition,
    toolNames: readonly string[],
  ): string {
    let systemPrompt = resolved.systemPrompt
    if (!this.skillsLoader || !toolNames.includes('load_skill'))
      return systemPrompt
    const summary =
      this.skillsLoader.buildSkillsSummary?.() ||
      this.skillsLoader.summary?.() ||
      ''
    if (!summary) return systemPrompt
    systemPrompt +=
      '\n\n## 可加载的技能 (load_skill)\n\n' +
      `${summary}\n\n` +
      '遇到对应专题时, 先调 load_skill 把技能内容拉进上下文。'
    return systemPrompt
  }
}

function userAgentSource(root: string): ExtensionSourceInput | null {
  if (!existsSync(join(root, 'agents.json'))) return null
  return {
    id: 'emperor-user-agents',
    kind: 'user',
    root,
    manifests: ['agents.json'],
    trusted: true,
    readOnly: false,
  }
}

export function builtinAgentManifestPath(templatesDir: string): string {
  return join(resolveBuiltinAgentRoot(templatesDir), 'agents.json')
}

function resolveBuiltinAgentRoot(preferred: string): string {
  const candidates = [
    preferred,
    join(preferred, 'subagents'),
    join(
      SOURCE_MODULE_DIRECTORY,
      '..',
      '..',
      '..',
      '..',
      'templates',
      'subagents',
    ),
  ]
  return (
    candidates.find((candidate) =>
      existsSync(join(candidate, 'agents.json')),
    ) ?? preferred
  )
}
