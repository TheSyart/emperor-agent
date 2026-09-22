import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ConfigResolver,
  defineConfigKey,
  effectiveConfigSnapshot,
  type EffectiveConfigSnapshot,
  type Resolved,
} from '../../config/resolver'
import { resolveMcpConfig } from '../../mcp/config'
import type { SkillManager } from '../../skills/manager'
import {
  defaultModelExecutionPolicy,
  MODEL_CONFIG_FILE,
  parseModelConfig,
  type ModelExecutionPolicy,
} from '../../config/model-config'

export interface CoreEffectiveConfigServiceDeps {
  skillManager?: SkillManager | null
  skillResolutions?: () => Array<Resolved<any>>
}

/**
 * Read-only adapter over existing fact sources. It intentionally does not
 * introduce a new config file or writer: old JSON/Skill stores
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
    const modelPolicy = await this.modelPolicyResolution()
    if (modelPolicy) resolutions.push(modelPolicy)
    resolutions.push(this.sandboxResolution())
    resolutions.push(
      (await resolveMcpConfig(this.root, {}, { preserveCorrupt: false }))
        .resolution,
    )
    resolutions.push(...this.skillResolutions())
    return effectiveConfigSnapshot(resolutions)
  }

  private sandboxResolution(): Resolved<Record<string, unknown>> {
    const key = defineConfigKey<Record<string, unknown>>({
      id: 'sandbox.runtime',
      builtin: {
        shell: {
          presets: ['read-only', 'workspace-write', 'danger-full-access'],
          defaultPreset: 'workspace-write',
          confines: 'file-writes',
          network: 'not-restricted',
          backends: {
            darwin: 'seatbelt',
            linux: 'bwrap',
            other: 'fail-closed',
          },
          escalation: 'one-shot-approval',
        },
        hooks: { containment: 'none', source: 'emperor-home/hooks.json' },
        mcp: { containment: 'none', approval: 'never' },
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
}
