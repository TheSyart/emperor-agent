/**
 * Non-kernel services the harness host keeps from the Emperor runtime:
 * Emperor Home bootstrap, session index, memory, projects, environment,
 * skills, scheduler, MCP, process runtime, and the model configuration.
 * The agent kernel itself is composed in `host.ts`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { loadLocalConfig } from '../../config/local-config'
import { loadModelConfig, type ModelConfig } from '../../config/model-config'
import {
  loadBundledToolCatalog,
  type LoadedToolCatalog,
} from '../../environment/catalog'
import { ManagedEnvironmentService } from '../../environment/managed'
import {
  EnvironmentProbe,
  missingSkillRequirementsFromStatus,
} from '../../environment/probe'
import { OsSandboxController } from '../../environment/sandbox'
import { ExecutionEnvironmentService } from '../../environment/snapshot'
import { MCPClient } from '../../mcp/client'
import { MemoryStore } from '../../memory/store'
import { TokenTracker } from '../../memory/token-tracker'
import { OwnedProcessRuntime } from '../../processes/runtime'
import { ProjectStore } from '../../projects/store'
import { bootstrapEmperorHome } from '../../runtime/installation'
import {
  migrateLegacyStateRoot,
  type LegacyStateMigrationResult,
} from '../../runtime/migrate-state-root'
import {
  ensureRuntimeStateDirs,
  legacyDefaultStateRoot,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../../runtime/paths'
import { SchedulerService } from '../../scheduler/service'
import { SchedulerStore } from '../../scheduler/store'
import { ensureUserProfileFile } from '../../sessions/onboarding'
import { SessionStore } from '../../sessions/store'
import type { WebFetchClient } from '../../network/web-fetch-client'
import { SkillChangeDetector } from '../../skills/change-detector'
import { SkillLoaders, type FileSkillsLoader } from '../../skills/file-loader'
import { SkillInstallService } from '../../skills/install'
import { SkillLibrary } from '../../skills/library'
import { SkillManager } from '../../skills/manager'

/** Marks a sessions directory written by the harness kernel. */
export const HARNESS_SESSIONS_MARKER = '.harness-kernel-v1'

/**
 * The harness kernel starts with fresh sessions: a sessions directory from
 * the previous kernel is moved aside (never deleted) to
 * `sessions.legacy-<timestamp>` on first start.
 */
export function archiveLegacySessions(sessionsRoot: string): string | null {
  if (existsSync(`${sessionsRoot}/${HARNESS_SESSIONS_MARKER}`)) return null
  let archived: string | null = null
  if (existsSync(sessionsRoot) && readdirSync(sessionsRoot).length > 0) {
    archived = `${sessionsRoot}.legacy-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(sessionsRoot, archived)
  }
  mkdirSync(sessionsRoot, { recursive: true })
  writeFileSync(
    `${sessionsRoot}/${HARNESS_SESSIONS_MARKER}`,
    `${new Date().toISOString()}\n`,
  )
  return archived
}

export interface KeptServicesOptions {
  root: string
  stateRoot?: string | null
  stateRootSource?: 'explicit' | 'env' | 'default' | null
  templatesDir?: string | null
  emperorHomePrepared?: boolean
  appVersion?: string
  runtimeRevision?: string
  legacyRuntimeRoot?: string | null
  legacyRuntimeSkillsHandled?: boolean
  /** Host public-HTTPS client (Plugin installs, Skill URL imports). */
  webFetchClient?: WebFetchClient | null
}

export interface KeptServices {
  paths: RuntimePaths
  root: string
  templatesDir: string
  legacyStateMigration: LegacyStateMigrationResult
  /** Where pre-harness sessions were moved on first start, if any. */
  archivedLegacySessions: string | null
  localConfig: Awaited<ReturnType<typeof loadLocalConfig>>
  modelConfig: ModelConfig
  sessionStore: SessionStore
  sharedMemory: MemoryStore
  projectStore: ProjectStore
  tokenTracker: TokenTracker
  environmentCatalog: LoadedToolCatalog
  environmentProbe: EnvironmentProbe
  executionEnvironmentService: ExecutionEnvironmentService
  processSandbox: OsSandboxController
  processRuntime: OwnedProcessRuntime
  skillManager: SkillManager
  skillInstallService: SkillInstallService
  managedEnvironmentService: ManagedEnvironmentService
  /** Per-project Skill loaders (one per project root; `forProject(null)` = chat). */
  skillLoaders: SkillLoaders
  /** The chat (no project) loader, for project-independent views. */
  skillsLoader: FileSkillsLoader
  /** Skill writes shared by the Skill API and the `skill_manage` tool. */
  skillLibrary: SkillLibrary
  skillChangeDetector: SkillChangeDetector
  schedulerStore: SchedulerStore
  schedulerService: SchedulerService
  mcpClient: MCPClient
}

export interface KeptServiceHooks {
  /** Host event sink (non-session events: scheduler, MCP, environment, skills). */
  emit(event: Record<string, unknown>): Promise<void> | void
  activeSessionId(): string | null
  activeWorkspaceRoot(): string
  refreshRuntimeContext(): void
}

export async function createKeptServices(
  opts: KeptServicesOptions,
  hooks: KeptServiceHooks,
): Promise<KeptServices> {
  const environmentCatalog = loadBundledToolCatalog()
  const paths = resolveRuntimePaths(opts.root, {
    stateRoot: opts.stateRoot ?? null,
    stateRootSource: opts.stateRootSource ?? null,
    templatesDir: opts.templatesDir ?? null,
  })
  // runtimeRoot holds bundled read-only resources (in dev it is the repo, in
  // headless ACP the cwd), so it is never created here; only Emperor Home is.
  const root = paths.runtimeRoot
  if (!opts.emperorHomePrepared) {
    bootstrapEmperorHome({
      emperorHome: paths.stateRoot,
      source: paths.stateRootSource,
      legacyHome:
        paths.stateRootSource === 'default' ? legacyDefaultStateRoot() : null,
      appVersion: opts.appVersion ?? '0.0.0-headless',
      runtimeRevision: opts.runtimeRevision ?? environmentCatalog.revision,
    })
  }
  ensureRuntimeStateDirs(paths)
  const migrationPaths = opts.legacyRuntimeRoot
    ? resolveRuntimePaths(opts.legacyRuntimeRoot, {
        stateRoot: paths.stateRoot,
      })
    : paths
  const legacyStateMigration = migrateLegacyStateRoot(migrationPaths, {
    excludePreviousStateSkills: Boolean(
      opts.legacyRuntimeRoot && opts.legacyRuntimeSkillsHandled,
    ),
  })
  const localConfig = await loadLocalConfig(paths.stateRoot, {
    preserveCorrupt: false,
  })
  const templatesDir = paths.templatesDir
  const userFile = ensureUserProfileFile(paths.stateRoot, templatesDir)
  const sharedMemory = new MemoryStore(paths.memoryRoot, userFile, {
    memoryTemplate: existsSync(join(templatesDir, 'init', 'MEMORY.md'))
      ? join(templatesDir, 'init', 'MEMORY.md')
      : null,
  })
  const modelConfig = await loadModelConfig(paths.stateRoot, { create: true })
  const archivedLegacySessions = archiveLegacySessions(paths.sessionsRoot)
  const sessionStore = new SessionStore(paths.stateRoot)
  const projectStore = new ProjectStore(paths.stateRoot, {
    versions: sharedMemory.versions,
  })
  const tokenTracker = new TokenTracker(paths.tokensFile)
  const environmentProbe = new EnvironmentProbe({
    catalog: () => environmentCatalog,
    env: () => process.env,
  })
  const executionEnvironmentService = new ExecutionEnvironmentService({
    probe: environmentProbe,
    env: () => process.env,
    managedBinRoot: paths.environmentBinRoot,
    managedRegistryFile: paths.environmentRegistryFile,
    emperorHome: paths.stateRoot,
    userSkillsRoot: paths.userSkillsRoot,
    environmentRoot: paths.environmentRoot,
    scratchRoot: join(paths.sessionsRoot, '.scratch'),
  })
  const processSandbox = new OsSandboxController()
  const processRuntime = new OwnedProcessRuntime(paths.stateRoot, {
    sandbox: processSandbox,
  })
  const skillManager = new SkillManager({
    runtimeRoot: root,
    stateRoot: paths.stateRoot,
  })
  const skillInstallService = new SkillInstallService({
    manager: skillManager,
    stateRoot: paths.stateRoot,
    resolveMissing: async (requirements) => {
      const skillName = 'install-candidate'
      const status = await environmentProbe.getStatus({
        projectRoot: hooks.activeWorkspaceRoot(),
        forceRefresh: true,
        skillRequirements: [{ skillName, skillStatus: 'active', requirements }],
      })
      return missingSkillRequirementsFromStatus(status, skillName, requirements)
    },
  })
  const managedEnvironmentService = new ManagedEnvironmentService({
    stateRoot: paths.stateRoot,
    skillManager,
    processRunner: processRuntime,
    onEnvironmentChanged: async () => {
      environmentProbe.invalidate()
      hooks.refreshRuntimeContext()
      await skillInstallService.reconcileBlocked()
    },
    onInstallEvent: async (event) => {
      const name =
        event.phase === 'started'
          ? 'environment_install_started'
          : event.phase === 'completed'
            ? 'environment_install_completed'
            : 'environment_install_failed'
      await hooks.emit({
        event: name,
        job_id: event.jobId,
        tool_id: event.toolId,
        status: event.status,
        completed_steps: event.phase === 'completed' ? 1 : 0,
        total_steps: 1,
        error_code: event.errorCode,
        install_source: event.source,
        placement: event.placement,
        recipe_trust: event.recipeTrust,
      })
    },
  })
  const skillLoaders = new SkillLoaders({
    runtimeRoot: root,
    stateRoot: paths.stateRoot,
  })
  const skillsLoader = skillLoaders.forProject(null)
  const skillChangeDetector = new SkillChangeDetector(
    [paths.userSkillsRoot],
    async ({ catalogVersion }) => {
      hooks.refreshRuntimeContext()
      await hooks.emit({
        event: 'skill_catalog_changed',
        catalog_version: catalogVersion,
      })
    },
  )
  const skillLibrary = new SkillLibrary({
    loaders: skillLoaders,
    fetchClient: () => opts.webFetchClient ?? null,
    onChanged: () => {
      skillChangeDetector.notify()
    },
  })
  const schedulerStore = new SchedulerStore(paths.stateRoot)
  const schedulerService = new SchedulerService(schedulerStore, {
    eventSink: async (event) => {
      await hooks.emit(event)
    },
    targetSessionId: () => hooks.activeSessionId(),
  })
  const mcpClient = new MCPClient(paths.stateRoot, {
    processRuntime,
    workspaceRoot: () => hooks.activeWorkspaceRoot(),
    ownerSessionId: () => hooks.activeSessionId(),
    onStateChange: async (snapshot) => {
      await hooks.emit({
        event: 'mcp_connection_state',
        ...(snapshot as unknown as Record<string, unknown>),
      })
    },
  })
  return {
    paths,
    root,
    templatesDir,
    legacyStateMigration,
    archivedLegacySessions,
    localConfig,
    modelConfig,
    sessionStore,
    sharedMemory,
    projectStore,
    tokenTracker,
    environmentCatalog,
    environmentProbe,
    executionEnvironmentService,
    processSandbox,
    processRuntime,
    skillManager,
    skillInstallService,
    managedEnvironmentService,
    skillLoaders,
    skillsLoader,
    skillLibrary,
    skillChangeDetector,
    schedulerStore,
    schedulerService,
    mcpClient,
  }
}
