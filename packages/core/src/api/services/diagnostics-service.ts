import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { localConfigDiagnostics, type LocalConfigDiagnostics } from '../../config/local-config'
import { loadModelConfig, validateCompleteModelEntries } from '../../config/model-config'
import { listRecentPromptSnapshots } from '../../prompts/manifest'
import type { RuntimePaths } from '../../runtime/paths'
import type { LegacyStateMigrationResult } from '../../runtime/migrate-state-root'

type Dict = Record<string, unknown>

export interface CoreDiagnosticsServiceDeps {
  runtimePaths?: RuntimePaths | null
  legacyStateMigration?: LegacyStateMigrationResult | null
  /** Detects private `.emperor/sessions`|`.emperor/memory` already sitting inside the
   * active project's own source tree. Returns null when there is no bound project. */
  activeProjectLegacyPrivateData?: () => { projectPath: string; sessions: boolean; memory: boolean } | null
  schedulerDiagnostics?: () => Dict
  runtimeStats?: () => Dict
  workspacePolicy?: () => Dict
  externalPayload?: () => Dict
  activeTasks?: () => unknown[]
  desktopPetPayload?: () => Dict | Promise<Dict>
}

export interface CoreDiagnosticsPayload {
  root: string
  paths: Dict
  modelConfig: Dict
  localConfig: LocalConfigDiagnostics
  legacyStateMigration: Dict
  projectLegacyPrivateData: Dict | null
  scheduler: Dict
  runtime: Dict
  workspacePolicy: Dict
  promptSnapshots: Dict
  external: Dict
  activeTasks: unknown[]
  desktopPet: Dict
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
      runtime: this.deps.runtimeStats?.() ?? {},
      workspacePolicy: this.deps.workspacePolicy?.() ?? {},
      promptSnapshots: this.promptSnapshotsPayload(),
      external: this.deps.externalPayload?.() ?? {},
      activeTasks: this.deps.activeTasks?.() ?? [],
      desktopPet: await this.deps.desktopPetPayload?.() ?? {},
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
      nodeRuntime: typeof process.versions.node === 'string' && process.versions.node.length > 0,
      desktopRenderer: existsSync(join(this.root, 'desktop', 'out', 'renderer', 'index.html')),
      desktopPetNodeModules: existsSync(join(this.root, 'desktop-pet', 'node_modules')),
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
    }
  }

  private promptSnapshotsPayload(): Dict {
    const paths = this.deps.runtimePaths
    if (!paths) return { count: 0, recent: [] }
    return listRecentPromptSnapshots(paths.sessionsRoot, 5)
  }
}
