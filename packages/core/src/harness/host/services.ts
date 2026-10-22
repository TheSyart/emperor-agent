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
import type { EnvironmentProcessRunner } from '../../environment/process-runner'
import { OsSandboxController } from '../../environment/sandbox'
import { UnsandboxedConsentRegistry } from '../../sandbox/consent'
import { ContainmentBackend } from '../../sandbox/policy'
import { ExecutionEnvironmentService } from '../../environment/snapshot'
import { MCPClient } from '../../mcp/client'
import { MemoryStore } from '../../memory/store'
import { TokenTracker } from '../../memory/token-tracker'
import { OwnedProcessRuntime } from '../../processes/runtime'
import { ProjectStore } from '../../projects/store'
import {
  bootstrapEmperorHome,
  runPendingDataMigrations,
} from '../../runtime/installation'
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
import {
  createLocalKeySealer,
  type SecretSealer,
} from '../../security/secret-sealer'
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
  /**
   * Seals model API keys and MCP tokens at rest (SEC-06). The desktop main
   * process passes one over its `LocalSecretStore`; absent (ACP, headless),
   * Core uses its own implementation over the same key file.
   */
  secretSealer?: SecretSealer | null
  /**
   * The one process containment (SEC-08) for the Shell, MCP stdio servers,
   * plugin hooks and the environment installer; tests replace it.
   */
  containmentBackend?: ContainmentBackend
  /**
   * Runs the toolchain version probes (`git --version`, `gh --version`, …);
   * tests answer them without starting processes.
   */
  environmentProbeRunner?: EnvironmentProcessRunner
}

export interface KeptServices {
  paths: RuntimePaths
  root: string
  templatesDir: string
  legacyStateMigration: LegacyStateMigrationResult
  /** Where pre-harness sessions were moved on first start, if any. */
  archivedLegacySessions: string | null
  localConfig: Awaited<ReturnType<typeof loadLocalConfig>>
  /** The one sealer for `model_config.json` and `mcp_config.json` secrets. */
  secretSealer: SecretSealer
  modelConfig: ModelConfig
  sessionStore: SessionStore
  sharedMemory: MemoryStore
  projectStore: ProjectStore
  tokenTracker: TokenTracker
  environmentCatalog: LoadedToolCatalog
  environmentProbe: EnvironmentProbe
  executionEnvironmentService: ExecutionEnvironmentService
  /** The one process containment backend (SEC-08). */
  containment: ContainmentBackend
  processSandbox: OsSandboxController
  processRuntime: OwnedProcessRuntime
  /** The user's answers for running their MCP servers outside an unavailable sandbox. */
  unsandboxedConsent: UnsandboxedConsentRegistry
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
    await runPendingDataMigrations(paths.stateRoot, {
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
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
  const secretSealer =
    opts.secretSealer ?? createLocalKeySealer(paths.stateRoot)
  const modelConfig = await loadModelConfig(paths.stateRoot, {
    create: true,
    sealer: secretSealer,
  })
  const archivedLegacySessions = archiveLegacySessions(paths.sessionsRoot)
  const sessionStore = new SessionStore(paths.stateRoot)
  const projectStore = new ProjectStore(paths.stateRoot, {
    versions: sharedMemory.versions,
  })
  const tokenTracker = new TokenTracker(paths.tokensFile)
  const environmentProbe = new EnvironmentProbe({
    catalog: () => environmentCatalog,
    env: () => process.env,
    ...(opts.environmentProbeRunner
      ? { runner: opts.environmentProbeRunner }
      : {}),
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
  const containment = opts.containmentBackend ?? new ContainmentBackend()
  const processSandbox = new OsSandboxController({ backend: containment })
  const processRuntime = new OwnedProcessRuntime(paths.stateRoot, {
    sandbox: processSandbox,
  })
  const unsandboxedConsent = new UnsandboxedConsentRegistry(paths.stateRoot)
  const skillManager = new SkillManager({
    runtimeRoot: root,
    stateRoot: paths.stateRoot,
  })
  // Chat sessions work here; user-wide services (Skill installs, the global
  // MCP servers) use it instead of whichever session is in view (KRN-01).
  const chatWorkspace = join(paths.stateRoot, 'workspace')
  const skillInstallService = new SkillInstallService({
    manager: skillManager,
    stateRoot: paths.stateRoot,
    resolveMissing: async (requirements) => {
      const skillName = 'install-candidate'
      const status = await environmentProbe.getStatus({
        projectRoot: chatWorkspace,
        forceRefresh: true,
        skillRequirements: [{ skillName, skillStatus: 'active', requirements }],
      })
      return missingSkillRequirementsFromStatus(status, skillName, requirements)
    },
  })
  const managedEnvironmentService = new ManagedEnvironmentService({
    stateRoot: paths.stateRoot,
    skillManager,
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
  })
  // The global MCP servers (mcp_config.json and user-wide plugins) serve
  // every session; project-scoped plugins run in per-project instances.
  const mcpClient = new MCPClient(paths.stateRoot, {
    sealer: secretSealer,
    processRuntime,
    unsandboxedConsent,
    workspaceRoot: chatWorkspace,
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
    secretSealer,
    modelConfig,
    sessionStore,
    sharedMemory,
    projectStore,
    tokenTracker,
    environmentCatalog,
    environmentProbe,
    executionEnvironmentService,
    containment,
    processSandbox,
    processRuntime,
    unsandboxedConsent,
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
