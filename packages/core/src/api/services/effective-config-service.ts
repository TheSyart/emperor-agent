import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ConfigResolver,
  defineConfigKey,
  effectiveConfigSnapshot,
  type ConfigCandidate,
  type ConfigLayerKind,
  type ConfigSourceTrust,
  type EffectiveConfigSnapshot,
  type Resolved,
} from '../../config/resolver'
import {
  LOCAL_CONFIG_FILE,
  loadLocalConfig,
  localConfigDiagnostics,
  localConfigPath,
} from '../../config/local-config'
import { resolveMcpConfig } from '../../mcp/config'
import type {
  ExtensionSnapshot,
  ExtensionSourceSnapshot,
} from '../../extensions/resolver'
import type { SkillManager } from '../../skills/manager'
import {
  resolveHybridMemoryMode,
  type HybridMemoryModeValue,
} from '../../memory/hybrid-capability'
import {
  resolveCodeIntelligenceMode,
  type CodeIntelligenceModeValue,
} from '../../code-intelligence/capability'
import {
  resolveSoftGitRewindMode,
  type SoftGitRewindModeValue,
} from '../../checkpoints/soft-git-rewind'
import { loadExternalConfig } from '../../external/config'
import {
  defaultModelExecutionPolicy,
  MODEL_CONFIG_FILE,
  parseModelConfig,
  type ModelExecutionPolicy,
} from '../../config/model-config'

export interface CoreEffectiveConfigServiceDeps {
  skillManager?: SkillManager | null
  skillResolutions?: () => Array<Resolved<any>>
  agentDefinitions?: () => ExtensionSnapshot
}

/**
 * Read-only adapter over existing fact sources. It intentionally does not
 * introduce a new config file or writer: old JSON/Skill/AgentDefinition stores
 * remain authoritative and can be rolled back independently.
 */
export class CoreEffectiveConfigService {
  readonly root: string
  private readonly deps: CoreEffectiveConfigServiceDeps

  constructor(root: string, deps: CoreEffectiveConfigServiceDeps = {}) {
    this.root = resolve(root)
    this.deps = deps
  }

  async payload(): Promise<EffectiveConfigSnapshot> {
    const resolutions: Resolved<any>[] = []
    resolutions.push(await this.permissionResolution())
    resolutions.push(await this.codeIntelligenceResolution())
    resolutions.push(await this.hybridMemoryResolution())
    resolutions.push(await this.softGitRewindResolution())
    const modelPolicy = await this.modelPolicyResolution()
    if (modelPolicy) resolutions.push(modelPolicy)
    resolutions.push(this.sandboxResolution())
    resolutions.push(
      (await resolveMcpConfig(this.root, {}, { preserveCorrupt: false }))
        .resolution,
    )
    resolutions.push(
      (await loadExternalConfig(this.root, { preserveInvalid: false }))
        .resolution,
    )
    resolutions.push(...this.skillResolutions())
    resolutions.push(...this.agentDefinitionResolutions())
    return effectiveConfigSnapshot(resolutions)
  }

  private async permissionResolution(): Promise<Resolved<unknown[]>> {
    const key = defineConfigKey<unknown[]>({
      id: 'permissions.rules',
      builtin: [],
      merge: (current, next) => [...current, ...next.value],
      restrictUntrustedProject: (current, next) => [
        ...current,
        ...next.value.filter((rule) => {
          if (!rule || typeof rule !== 'object' || Array.isArray(rule))
            return true
          return (
            String((rule as Record<string, unknown>).action)
              .trim()
              .toLowerCase() !== 'allow'
          )
        }),
      ],
    })
    const candidates: ConfigCandidate<unknown[]>[] = []
    const diagnostics = await localConfigDiagnostics(this.root)
    if (existsSync(localConfigPath(this.root)) && diagnostics.status === 'ok') {
      const local = await loadLocalConfig(this.root, { preserveCorrupt: false })
      candidates.push({
        source: {
          kind: 'user',
          id: LOCAL_CONFIG_FILE,
          trust: 'trusted',
        },
        value: local.permissions.rules,
      })
    }
    return new ConfigResolver().resolve(key, { candidates })
  }

  private async hybridMemoryResolution(): Promise<
    Resolved<HybridMemoryModeValue>
  > {
    const candidates: ConfigCandidate<HybridMemoryModeValue>[] = []
    const diagnostics = await localConfigDiagnostics(this.root)
    if (existsSync(localConfigPath(this.root)) && diagnostics.status === 'ok') {
      const local = await loadLocalConfig(this.root, { preserveCorrupt: false })
      candidates.push({
        source: {
          kind: 'user',
          id: LOCAL_CONFIG_FILE,
          trust: 'trusted',
        },
        value: { mode: local.memory.hybridMemory },
      })
    }
    return resolveHybridMemoryMode(candidates)
  }

  private async codeIntelligenceResolution(): Promise<
    Resolved<CodeIntelligenceModeValue>
  > {
    const candidates: ConfigCandidate<CodeIntelligenceModeValue>[] = []
    const diagnostics = await localConfigDiagnostics(this.root)
    if (existsSync(localConfigPath(this.root)) && diagnostics.status === 'ok') {
      const local = await loadLocalConfig(this.root, { preserveCorrupt: false })
      candidates.push({
        source: {
          kind: 'user',
          id: LOCAL_CONFIG_FILE,
          trust: 'trusted',
        },
        value: { mode: local.codeIntelligence.mode },
      })
    }
    return resolveCodeIntelligenceMode(candidates)
  }

  private async softGitRewindResolution(): Promise<
    Resolved<SoftGitRewindModeValue>
  > {
    const candidates: ConfigCandidate<SoftGitRewindModeValue>[] = []
    const diagnostics = await localConfigDiagnostics(this.root)
    if (existsSync(localConfigPath(this.root)) && diagnostics.status === 'ok') {
      const local = await loadLocalConfig(this.root, { preserveCorrupt: false })
      candidates.push({
        source: {
          kind: 'user',
          id: LOCAL_CONFIG_FILE,
          trust: 'trusted',
        },
        value: { mode: local.workspace.gitRewind.mode },
      })
    }
    return resolveSoftGitRewindMode(candidates)
  }

  private sandboxResolution(): Resolved<Record<string, unknown>> {
    const key = defineConfigKey<Record<string, unknown>>({
      id: 'sandbox.runtime',
      builtin: {
        runCommand: {
          readonly: { containment: 'preferred', network: 'deny' },
          mutating: { containment: 'required', network: 'deny' },
        },
        hooks: { containment: 'preferred', network: 'allow' },
        mcp: { containment: 'preferred', network: 'allow' },
      },
      merge: (current) => ({ ...current }),
    })
    return new ConfigResolver().resolve(key)
  }

  private async modelPolicyResolution(): Promise<Resolved<ModelExecutionPolicy> | null> {
    const path = resolve(this.root, MODEL_CONFIG_FILE)
    if (!existsSync(path)) return null
    let policy: ModelExecutionPolicy
    try {
      policy = parseModelConfig(
        JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>,
      ).policy
    } catch {
      // Effective-config inspection is read-only and must never isolate a
      // corrupt model file merely to produce diagnostics.
      return null
    }
    const key = defineConfigKey<ModelExecutionPolicy>({
      id: 'model.executionPolicy',
      builtin: defaultModelExecutionPolicy(),
    })
    return new ConfigResolver().resolve(key, {
      candidates: [
        {
          source: {
            kind: 'user',
            id: MODEL_CONFIG_FILE,
            trust: 'trusted',
          },
          value: policy,
        },
      ],
    })
  }

  private skillResolutions(): Array<Resolved<any>> {
    if (this.deps.skillResolutions) return this.deps.skillResolutions()
    const manager = this.deps.skillManager
    if (!manager) return []
    return manager
      .listRecords()
      .map((record) => manager.resolveWithProvenance(record.name))
  }

  private agentDefinitionResolutions(): Array<Resolved<any>> {
    const snapshot = this.deps.agentDefinitions?.()
    if (!snapshot) return []
    return snapshot.agents.map((agent) => {
      const key = defineConfigKey<Record<string, unknown> | null>({
        id: `agentDefinitions.${agent.definition.name}`,
        builtin: null,
      })
      return new ConfigResolver().resolve(key, {
        candidates: [
          ...agent.overriddenSources.map((overridden) => ({
            source: configSourceForExtension(overridden.source),
            value: null,
          })),
          {
            source: configSourceForExtension(agent.source),
            value: {
              ...agent.definition,
              extensionSourceKind: agent.source.kind,
              extensionSourceTrust: agent.source.trust,
            },
          },
        ],
      })
    })
  }
}

function configSourceForExtension(source: ExtensionSourceSnapshot): {
  kind: ConfigLayerKind
  id: string
  trust: ConfigSourceTrust
} {
  if (source.kind === 'managed')
    return { kind: 'managed', id: source.id, trust: 'managed' }
  if (source.kind === 'project')
    return {
      kind: 'project',
      id: source.id,
      trust: source.trust === 'project' ? 'trusted' : 'untrusted',
    }
  if (source.kind === 'builtin')
    return { kind: 'builtin', id: source.id, trust: 'trusted' }
  return {
    kind: 'user',
    id: `${source.kind}:${source.id}`,
    trust: 'trusted',
  }
}
