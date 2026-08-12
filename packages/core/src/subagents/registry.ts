import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
    const resolvedSnapshot = new ExtensionResolver({
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
    this.extensionSnapshot = supportedRuntimeSnapshot(resolvedSnapshot)
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
    if (!this.skillsLoader || !toolNames.includes('Skill')) return systemPrompt
    const summary =
      this.skillsLoader.buildSkillsSummary?.() ||
      this.skillsLoader.summary?.() ||
      ''
    if (!summary) return systemPrompt
    systemPrompt +=
      '\n\n## 可加载的技能 (Skill)\n\n' +
      `${summary}\n\n` +
      '遇到对应专题时, 先调 Skill 把技能内容拉进上下文。'
    return systemPrompt
  }
}

function supportedRuntimeSnapshot(
  snapshot: ExtensionSnapshot,
): ExtensionSnapshot {
  const unsupported = snapshot.agents.filter(
    (agent) => agent.definition.memory.mode !== 'none',
  )
  if (unsupported.length === 0) return snapshot
  const rejected = new Set(unsupported.map((agent) => agent.definition.name))
  const diagnostics = [
    ...snapshot.diagnostics,
    ...unsupported.map((agent) => ({
      code: 'agent_memory_unsupported',
      severity: 'error' as const,
      sourceId: agent.source.id,
      path: agent.definition.prompt,
      agentName: agent.definition.name,
      message:
        'AgentDefinition memory modes are not supported by the current subagent runtime; the agent was disabled.',
    })),
  ]
  const agents = snapshot.agents.filter(
    (agent) => !rejected.has(agent.definition.name),
  )
  const aliases = Object.fromEntries(
    Object.entries(snapshot.aliases).filter(([, name]) => !rejected.has(name)),
  )
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        base: snapshot.revision,
        rejected: [...rejected].sort(),
      }),
    )
    .digest('hex')
  return Object.freeze({
    ...snapshot,
    revision,
    agents: Object.freeze(agents) as unknown as ExtensionSnapshot['agents'],
    aliases: Object.freeze(aliases),
    diagnostics: Object.freeze(
      diagnostics,
    ) as unknown as ExtensionSnapshot['diagnostics'],
  })
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
