import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  localConfigDiagnostics,
  type LocalConfigDiagnostics,
} from '../../config/local-config'
import {
  loadModelConfig,
  validateCompleteModelEntries,
} from '../../config/model-config'
import { listRecentPromptSnapshots } from '../../prompts/manifest'
import type { RuntimePaths } from '../../runtime/paths'
import type { LegacyStateMigrationResult } from '../../runtime/migrate-state-root'
import type { ActiveTaskInfo, ActiveTaskKind } from '../../runtime/active'
import type { RuntimeStats } from '../../runtime/store'
import type { SessionRuntimeActorSnapshot } from '../../runtime/session-runtime'
import type { LifecycleSupervisorSnapshot } from '../../runtime/lifecycle'
import type { SubagentSupervisorSnapshot } from '../../subagents/supervisor'
import type { CoreDesktopPetPayload } from './desktop-pet-service'
import { RUNTIME_MANIFEST_FILE } from '../../runtime/resources'
import { toSafeError } from '../../errors'
import type { MCPClientSnapshot } from '../../mcp/client'
import type { ExtensionSnapshot } from '../../extensions/resolver'
import type { EffectiveConfigSnapshot } from '../../config/resolver'
import type { HybridMemoryServiceDiagnostics } from '../../memory/hybrid-service'
import type { CodeIntelligenceServiceDiagnostics } from '../../code-intelligence/service'

type Dict = Record<string, unknown>

export interface CoreDiagnosticsServiceDeps {
  runtimePaths?: RuntimePaths | null
  legacyStateMigration?: LegacyStateMigrationResult | null
  /** Detects private `.emperor/sessions`|`.emperor/memory` already sitting inside the
   * active project's own source tree. Returns null when there is no bound project. */
  activeProjectLegacyPrivateData?: () => {
    projectPath: string
    sessions: boolean
    memory: boolean
  } | null
  schedulerDiagnostics?: () => Dict
  runtimeStats?: () => Partial<RuntimeStats>
  workspacePolicy?: () => Dict
  sandboxCapability?: () => Dict
  processRuntime?: () => Dict
  lifecycle?: () => LifecycleSupervisorSnapshot
  subagents?: () => SubagentSupervisorSnapshot
  agentDefinitions?: () => ExtensionSnapshot
  effectiveConfig?: () => Promise<EffectiveConfigSnapshot>
  hybridMemory?: () => HybridMemoryServiceDiagnostics
  codeIntelligence?: () => CodeIntelligenceServiceDiagnostics
  mcp?: () => MCPClientSnapshot
  externalPayload?: () => Dict
  activeTasks?: () => unknown[]
  sessionRuntimes?: () => SessionRuntimeActorSnapshot[]
  desktopPetPayload?: () =>
    Partial<CoreDesktopPetPayload> | Promise<Partial<CoreDesktopPetPayload>>
  environmentSummary?: () => Dict | Promise<Dict>
  goalDiagnostics?: () => Dict | Promise<Dict>
}

export interface CoreDiagnosticsPayload {
  root: string
  paths: Dict
  modelConfig: Dict
  localConfig: LocalConfigDiagnostics
  legacyStateMigration: Dict
  projectLegacyPrivateData: Dict | null
  scheduler: Dict
  runtime: RuntimeStats
  workspacePolicy: Dict
  sandbox: Dict
  processRuntime: Dict
  lifecycle: LifecycleSupervisorSnapshot | Dict
  subagents: SubagentSupervisorSnapshot | Dict
  agentDefinitions: ExtensionSnapshot | Dict
  effectiveConfig: EffectiveConfigSnapshot | Dict
  hybridMemory: HybridMemoryServiceDiagnostics | Dict
  codeIntelligence: CodeIntelligenceServiceDiagnostics | Dict
  mcp: MCPClientSnapshot
  promptSnapshots: Dict
  external: Dict
  activeTasks: ActiveTaskInfo[]
  sessionRuntimes: SessionRuntimeActorSnapshot[]
  desktopPet: CoreDesktopPetPayload
  environment: Dict
  goals: Dict
  dependencies: Dict
}

export class CoreDiagnosticsService {
  readonly root: string
  private readonly deps: CoreDiagnosticsServiceDeps

  constructor(root: string, deps: CoreDiagnosticsServiceDeps = {}) {
    this.root = resolve(root)
    this.deps = deps
  }

  async payload(): Promise<CoreDiagnosticsPayload> {
    return {
      root: this.root,
      paths: this.pathsPayload(),
      modelConfig: await this.modelConfig(),
      localConfig: await localConfigDiagnostics(this.configRoot()),
      legacyStateMigration: this.legacyStateMigrationPayload(),
      projectLegacyPrivateData: this.projectLegacyPrivateDataPayload(),
      scheduler: this.deps.schedulerDiagnostics?.() ?? {},
      runtime: runtimeStatsPayload(this.deps.runtimeStats?.()),
      workspacePolicy: this.deps.workspacePolicy?.() ?? {},
      sandbox: this.deps.sandboxCapability?.() ?? {},
      processRuntime: this.deps.processRuntime?.() ?? {},
      lifecycle: this.deps.lifecycle?.() ?? {},
      subagents: this.deps.subagents?.() ?? {},
      agentDefinitions: this.deps.agentDefinitions?.() ?? {},
      effectiveConfig: await this.effectiveConfigPayload(),
      hybridMemory: this.deps.hybridMemory?.() ?? {},
      codeIntelligence: this.deps.codeIntelligence?.() ?? {},
      mcp: this.deps.mcp?.() ?? {
        initialized: false,
        servers: [],
        ready: 0,
        configured: 0,
        tools: 0,
      },
      promptSnapshots: this.promptSnapshotsPayload(),
      external: this.deps.externalPayload?.() ?? {},
      activeTasks: activeTasksPayload(this.deps.activeTasks?.()),
      sessionRuntimes: this.deps.sessionRuntimes?.() ?? [],
      desktopPet: desktopPetPayload(await this.deps.desktopPetPayload?.()),
      environment: await this.environmentSummaryPayload(),
      goals: await this.goalDiagnosticsPayload(),
      dependencies: this.dependencies(),
    }
  }

  async modelConfig(): Promise<Dict> {
    const path = join(this.configRoot(), 'model_config.json')
    const exists = existsSync(path)
    const payload: Dict = {
      path,
      exists,
      status: exists ? 'unknown' : 'missing',
      error: '',
    }
    if (!exists) return payload
    try {
      const config = await loadModelConfig(this.configRoot(), { create: false })
      validateCompleteModelEntries(config.raw)
      payload.status = 'ok'
      payload.models = config.models.length
    } catch (err) {
      payload.status = 'invalid'
      payload.error = err instanceof Error ? err.message : String(err)
    }
    return payload
  }

  dependencies(): Dict {
    return {
      nodeRuntime:
        typeof process.versions.node === 'string' &&
        process.versions.node.length > 0,
      desktopRenderer: existsSync(
        join(this.root, 'desktop', 'out', 'renderer', 'index.html'),
      ),
      desktopPetModules: existsSync(
        join(this.root, 'desktop', 'src', 'pet', 'preload.js'),
      ),
    }
  }

  /** `emperor.local.json`/`model_config.json` now live under `stateRoot`, not `runtimeRoot`.
   * Falls back to `this.root` when no `runtimePaths` dep is supplied (simple unit tests). */
  private configRoot(): string {
    return this.deps.runtimePaths?.stateRoot ?? this.root
  }

  private legacyStateMigrationPayload(): Dict {
    const migration = this.deps.legacyStateMigration
    if (!migration) return { legacyStateRoots: [], copied: 0, skipped: 0 }
    return {
      legacyStateRoots: migration.legacyStateRoots,
      copied: migration.copied,
      skipped: migration.skipped,
      logPath: migration.logPath,
      reportPath: migration.reportPath,
    }
  }

  /** Diagnostics-only surface: reports (never auto-migrates or deletes) private data
   * found inside the active project's own `.emperor/` directory. */
  private projectLegacyPrivateDataPayload(): Dict | null {
    const detected = this.deps.activeProjectLegacyPrivateData?.() ?? null
    if (!detected || (!detected.sessions && !detected.memory)) return null
    return { ...detected }
  }

  private pathsPayload(): Dict {
    const paths = this.deps.runtimePaths
    if (!paths) return { runtimeRoot: this.root, stateRoot: this.root }
    return {
      ...paths,
      mcpConfigPath: join(paths.stateRoot, 'mcp_config.json'),
      runtimeManifestPath: join(paths.runtimeRoot, RUNTIME_MANIFEST_FILE),
      legacyRuntimeSkillsReceiptPath: join(
        paths.stateRoot,
        'migrations',
        'legacy-runtime-skills.json',
      ),
    }
  }

  private promptSnapshotsPayload(): Dict {
    const paths = this.deps.runtimePaths
    if (!paths) return { count: 0, recent: [] }
    return listRecentPromptSnapshots(paths.sessionsRoot, 5)
  }

  private async environmentSummaryPayload(): Promise<Dict> {
    if (!this.deps.environmentSummary) return {}
    try {
      return await this.deps.environmentSummary()
    } catch (error) {
      return { status: 'unavailable', error: toSafeError(error) }
    }
  }

  private async goalDiagnosticsPayload(): Promise<Dict> {
    if (!this.deps.goalDiagnostics) return {}
    try {
      return await this.deps.goalDiagnostics()
    } catch (error) {
      return { status: 'unavailable', error: toSafeError(error) }
    }
  }

  private async effectiveConfigPayload(): Promise<
    EffectiveConfigSnapshot | Dict
  > {
    if (!this.deps.effectiveConfig) return {}
    try {
      return await this.deps.effectiveConfig()
    } catch (error) {
      return { status: 'unavailable', error: toSafeError(error), entries: [] }
    }
  }
}

function runtimeStatsPayload(
  value: Partial<RuntimeStats> | undefined,
): RuntimeStats {
  return {
    version: Number(value?.version ?? 1),
    path: String(value?.path ?? ''),
    bytes: Number(value?.bytes ?? 0),
    events: Number(value?.events ?? 0),
    latestSeq: Number(value?.latestSeq ?? 0),
    latestTs: value?.latestTs ?? null,
    activeTurnEvents: Number(value?.activeTurnEvents ?? 0),
    activeTurns: Number(value?.activeTurns ?? 0),
    archiveFiles: Number(value?.archiveFiles ?? 0),
    archiveBytes: Number(value?.archiveBytes ?? 0),
    archives: value?.archives ?? [],
    lastArchiveAt: value?.lastArchiveAt ?? null,
    hotLimitEvents: Number(value?.hotLimitEvents ?? 0),
    hotLimitBytes: Number(value?.hotLimitBytes ?? 0),
    needsRotation: Boolean(value?.needsRotation),
  }
}

function activeTasksPayload(value: unknown[] | undefined): ActiveTaskInfo[] {
  return (value ?? [])
    .filter(isRecord)
    .map((task) => ({
      id: String(task.id ?? ''),
      kind: activeTaskKind(task.kind),
      label: String(task.label ?? task.title ?? task.id ?? ''),
      started_at: Number(task.started_at ?? task.startedAt ?? 0),
      turn_id: nullableText(task.turn_id ?? task.turnId),
      job_id: nullableText(task.job_id ?? task.jobId),
      session_id: nullableText(task.session_id ?? task.sessionId),
      cancelled: Boolean(task.cancelled),
    }))
    .filter((task) => task.id)
}

function desktopPetPayload(
  value: Partial<CoreDesktopPetPayload> | undefined,
): CoreDesktopPetPayload {
  return {
    enabled: Boolean(value?.enabled),
    autoStartWithWebui: Boolean(value?.autoStartWithWebui),
    running: Boolean(value?.running),
    pid: typeof value?.pid === 'number' ? value.pid : null,
    lastError: typeof value?.lastError === 'string' ? value.lastError : null,
    installCommand: String(value?.installCommand ?? ''),
    managedBy: String(value?.managedBy ?? ''),
    available: Boolean(value?.available),
  }
}

function activeTaskKind(value: unknown): ActiveTaskKind {
  return value === 'scheduler' || value === 'team' || value === 'watchlist'
    ? value
    : 'turn'
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? '')
  return text || null
}

function isRecord(value: unknown): value is Dict {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
