import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type StateRootSource = 'explicit' | 'env' | 'default'
export type PathScope = 'runtime' | 'builtin' | 'user' | 'project'
export type PathCreatePolicy = 'bootstrap' | 'lazy' | 'derived'

export type EmperorPathId =
  | 'runtimeRoot'
  | 'templates'
  | 'builtinSkills'
  | 'assets'
  | 'emperorHome'
  | 'installation'
  | 'settings'
  | 'modelConfig'
  | 'mcpConfig'
  | 'hooksConfig'
  | 'onboarding'
  | 'userAgents'
  | 'userSkills'
  | 'skillStaging'
  | 'skillRegistry'
  | 'plugins'
  | 'pluginKnownMarketplaces'
  | 'pluginInstalled'
  | 'pluginMarketplaces'
  | 'pluginCache'
  | 'pluginData'
  | 'pluginStaging'
  | 'environment'
  | 'managedEnvironmentBin'
  | 'managedEnvironmentTools'
  | 'managedEnvironmentData'
  | 'environmentRegistry'
  | 'environmentDownloads'
  | 'environmentJobs'
  | 'environmentInstallations'
  | 'environmentReceipts'
  | 'environmentLock'
  | 'memory'
  | 'sessions'
  | 'projects'
  | 'attachments'
  | 'media'
  | 'tokens'
  | 'scheduler'
  | 'team'
  | 'tasks'
  | 'processes'
  | 'control'
  | 'goals'
  | 'git'
  | 'codeIntelligence'
  | 'migrations'
  | 'projectEmperor'
  | 'projectSkills'

export interface PathDescriptor {
  id: EmperorPathId
  path: string
  scope: PathScope
  source: StateRootSource | 'runtime' | 'workspace'
  writable: boolean
  sensitive: boolean
  createPolicy: PathCreatePolicy
}

export interface EmperorPathCatalog {
  readonly runtimeRoot: string
  readonly emperorHome: string
  readonly emperorHomeSource: StateRootSource
  get(id: EmperorPathId): PathDescriptor
  list(): readonly PathDescriptor[]
  toRuntimePaths(): RuntimePaths
}

export interface RuntimePaths {
  runtimeRoot: string
  stateRoot: string
  stateRootSource: StateRootSource
  pathCatalog: EmperorPathCatalog
  templatesDir: string
  skillsDir: string
  assetsDir: string
  installationFile: string
  settingsFile: string
  modelConfigFile: string
  mcpConfigFile: string
  hooksConfigFile: string
  onboardingFile: string
  userAgentsRoot: string
  userSkillsRoot: string
  skillStagingRoot: string
  skillRegistryFile: string
  pluginsRoot: string
  pluginKnownMarketplacesFile: string
  pluginInstalledFile: string
  pluginMarketplacesRoot: string
  pluginCacheRoot: string
  pluginDataRoot: string
  pluginStagingRoot: string
  environmentRoot: string
  environmentBinRoot: string
  environmentToolsRoot: string
  environmentDataRoot: string
  environmentRegistryFile: string
  environmentDownloadsRoot: string
  environmentJobsRoot: string
  environmentInstallationsRoot: string
  environmentReceiptsRoot: string
  environmentLockFile: string
  memoryRoot: string
  sessionsRoot: string
  projectsRoot: string
  attachmentsRoot: string
  mediaRoot: string
  tokensFile: string
  schedulerRoot: string
  teamRoot: string
  tasksRoot: string
  processesRoot: string
  controlRoot: string
  goalsRoot: string
  gitRoot: string
  codeIntelligenceRoot: string
  migrationsRoot: string
  projectEmperorRoot: string | null
  projectSkillsRoot: string | null
}

export interface RuntimePathOptions {
  stateRoot?: string | null
  stateRootSource?: StateRootSource | null
  templatesDir?: string | null
  workspaceRoot?: string | null
}

/** Canonical default global private data root. Pure: never touches disk. */
export function defaultEmperorHome(): string {
  return join(homedir(), '.emperor')
}

/** Compatibility alias retained for internal callers while UI/docs use “Emperor Home”. */
export function defaultStateRoot(): string {
  return defaultEmperorHome()
}

/** Previous default root. Used only by the bootstrap migration coordinator. */
export function legacyDefaultStateRoot(): string {
  return join(homedir(), '.emperor-agent')
}

function resolveStateRoot(opts: RuntimePathOptions): {
  stateRoot: string
  source: StateRootSource
} {
  if (opts.stateRoot)
    return {
      stateRoot: resolve(opts.stateRoot),
      source: opts.stateRootSource ?? 'explicit',
    }
  const envDir = process.env.EMPEROR_CONFIG_DIR
  if (envDir) return { stateRoot: resolve(envDir), source: 'env' }
  return { stateRoot: resolve(defaultEmperorHome()), source: 'default' }
}

function descriptor(
  id: EmperorPathId,
  path: string,
  scope: PathScope,
  source: PathDescriptor['source'],
  writable: boolean,
  sensitive: boolean,
  createPolicy: PathCreatePolicy,
): PathDescriptor {
  return {
    id,
    path: resolve(path),
    scope,
    source,
    writable,
    sensitive,
    createPolicy,
  }
}

export function createEmperorPathCatalog(
  root: string,
  opts: RuntimePathOptions = {},
): EmperorPathCatalog {
  const runtimeRoot = resolve(root)
  const { stateRoot: emperorHome, source } = resolveStateRoot(opts)
  const workspaceRoot = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null
  const templates = resolve(opts.templatesDir || join(runtimeRoot, 'templates'))
  const environment = join(emperorHome, 'environment')
  const plugins = join(emperorHome, 'plugins')
  const entries: PathDescriptor[] = [
    descriptor(
      'runtimeRoot',
      runtimeRoot,
      'runtime',
      'runtime',
      false,
      false,
      'derived',
    ),
    descriptor(
      'templates',
      templates,
      'builtin',
      'runtime',
      false,
      false,
      'derived',
    ),
    descriptor(
      'builtinSkills',
      join(runtimeRoot, 'skills'),
      'builtin',
      'runtime',
      false,
      false,
      'derived',
    ),
    descriptor(
      'assets',
      join(runtimeRoot, 'assets'),
      'builtin',
      'runtime',
      false,
      false,
      'derived',
    ),
    descriptor(
      'emperorHome',
      emperorHome,
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'installation',
      join(emperorHome, 'installation.json'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'settings',
      join(emperorHome, 'settings.json'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'modelConfig',
      join(emperorHome, 'model_config.json'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'mcpConfig',
      join(emperorHome, 'mcp_config.json'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'hooksConfig',
      join(emperorHome, 'hooks_config.json'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'onboarding',
      join(emperorHome, 'onboarding.json'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'userAgents',
      join(emperorHome, 'agents'),
      'user',
      source,
      true,
      false,
      'lazy',
    ),
    descriptor(
      'userSkills',
      join(emperorHome, 'skills'),
      'user',
      source,
      true,
      false,
      'bootstrap',
    ),
    descriptor(
      'skillStaging',
      join(emperorHome, 'skills', '.staging'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'skillRegistry',
      join(emperorHome, 'skills', 'installed.v1.json'),
      'user',
      source,
      false,
      true,
      'derived',
    ),
    descriptor('plugins', plugins, 'user', source, true, true, 'bootstrap'),
    descriptor(
      'pluginKnownMarketplaces',
      join(plugins, 'known_marketplaces.json'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'pluginInstalled',
      join(plugins, 'installed_plugins.json'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'pluginMarketplaces',
      join(plugins, 'marketplaces'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'pluginCache',
      join(plugins, 'cache'),
      'user',
      source,
      true,
      false,
      'bootstrap',
    ),
    descriptor(
      'pluginData',
      join(plugins, 'data'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'pluginStaging',
      join(plugins, 'staging'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'environment',
      environment,
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'managedEnvironmentBin',
      join(environment, 'bin'),
      'user',
      source,
      true,
      false,
      'bootstrap',
    ),
    descriptor(
      'managedEnvironmentTools',
      join(environment, 'tools'),
      'user',
      source,
      true,
      false,
      'lazy',
    ),
    descriptor(
      'managedEnvironmentData',
      join(environment, 'data'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'environmentRegistry',
      join(environment, 'registry.v1.json'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'environmentDownloads',
      join(environment, 'downloads'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'environmentJobs',
      join(environment, 'jobs'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'environmentInstallations',
      join(environment, 'installations'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'environmentReceipts',
      join(environment, 'receipts'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'environmentLock',
      join(environment, 'environment.lock'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'memory',
      join(emperorHome, 'memory'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'sessions',
      join(emperorHome, 'sessions'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    descriptor(
      'projects',
      join(emperorHome, 'projects'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'attachments',
      join(emperorHome, 'memory', 'attachments'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'media',
      join(emperorHome, 'memory', 'media'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'tokens',
      join(emperorHome, 'tokens', 'tokens.jsonl'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'scheduler',
      join(emperorHome, 'scheduler'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'team',
      join(emperorHome, 'team'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'tasks',
      join(emperorHome, 'tasks'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'processes',
      join(emperorHome, 'processes'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'control',
      join(emperorHome, 'control'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'goals',
      join(emperorHome, 'goals'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'git',
      join(emperorHome, 'git'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'codeIntelligence',
      join(emperorHome, 'code-intelligence'),
      'user',
      source,
      true,
      true,
      'lazy',
    ),
    descriptor(
      'migrations',
      join(emperorHome, 'migrations'),
      'user',
      source,
      true,
      true,
      'bootstrap',
    ),
    ...(workspaceRoot
      ? [
          descriptor(
            'projectEmperor',
            join(workspaceRoot, '.emperor'),
            'project',
            'workspace',
            false,
            false,
            'derived',
          ),
          descriptor(
            'projectSkills',
            join(workspaceRoot, '.emperor', 'skills'),
            'project',
            'workspace',
            false,
            false,
            'derived',
          ),
        ]
      : []),
  ]
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const catalog: EmperorPathCatalog = {
    runtimeRoot,
    emperorHome,
    emperorHomeSource: source,
    get(id) {
      const entry = byId.get(id)
      if (!entry) throw new Error(`path descriptor is unavailable: ${id}`)
      return entry
    },
    list() {
      return entries
    },
    toRuntimePaths() {
      const path = (id: EmperorPathId) => byId.get(id)?.path ?? null
      return {
        runtimeRoot,
        stateRoot: emperorHome,
        stateRootSource: source,
        pathCatalog: catalog,
        templatesDir: path('templates')!,
        skillsDir: path('builtinSkills')!,
        assetsDir: path('assets')!,
        installationFile: path('installation')!,
        settingsFile: path('settings')!,
        modelConfigFile: path('modelConfig')!,
        mcpConfigFile: path('mcpConfig')!,
        hooksConfigFile: path('hooksConfig')!,
        onboardingFile: path('onboarding')!,
        userAgentsRoot: path('userAgents')!,
        userSkillsRoot: path('userSkills')!,
        skillStagingRoot: path('skillStaging')!,
        skillRegistryFile: path('skillRegistry')!,
        pluginsRoot: path('plugins')!,
        pluginKnownMarketplacesFile: path('pluginKnownMarketplaces')!,
        pluginInstalledFile: path('pluginInstalled')!,
        pluginMarketplacesRoot: path('pluginMarketplaces')!,
        pluginCacheRoot: path('pluginCache')!,
        pluginDataRoot: path('pluginData')!,
        pluginStagingRoot: path('pluginStaging')!,
        environmentRoot: path('environment')!,
        environmentBinRoot: path('managedEnvironmentBin')!,
        environmentToolsRoot: path('managedEnvironmentTools')!,
        environmentDataRoot: path('managedEnvironmentData')!,
        environmentRegistryFile: path('environmentRegistry')!,
        environmentDownloadsRoot: path('environmentDownloads')!,
        environmentJobsRoot: path('environmentJobs')!,
        environmentInstallationsRoot: path('environmentInstallations')!,
        environmentReceiptsRoot: path('environmentReceipts')!,
        environmentLockFile: path('environmentLock')!,
        memoryRoot: path('memory')!,
        sessionsRoot: path('sessions')!,
        projectsRoot: path('projects')!,
        attachmentsRoot: path('attachments')!,
        mediaRoot: path('media')!,
        tokensFile: path('tokens')!,
        schedulerRoot: path('scheduler')!,
        teamRoot: path('team')!,
        tasksRoot: path('tasks')!,
        processesRoot: path('processes')!,
        controlRoot: path('control')!,
        goalsRoot: path('goals')!,
        gitRoot: path('git')!,
        codeIntelligenceRoot: path('codeIntelligence')!,
        migrationsRoot: path('migrations')!,
        projectEmperorRoot: path('projectEmperor'),
        projectSkillsRoot: path('projectSkills'),
      }
    },
  }
  return catalog
}

export function resolveRuntimePaths(
  root: string,
  opts: RuntimePathOptions = {},
): RuntimePaths {
  return createEmperorPathCatalog(root, opts).toRuntimePaths()
}

export function ensureRuntimeStateDirs(paths: RuntimePaths): void {
  for (const dir of [
    paths.stateRoot,
    paths.memoryRoot,
    paths.sessionsRoot,
    join(paths.sessionsRoot, '.scratch'),
    paths.userSkillsRoot,
    paths.environmentRoot,
    paths.environmentBinRoot,
    paths.environmentDataRoot,
    paths.projectsRoot,
    paths.attachmentsRoot,
    paths.mediaRoot,
    paths.schedulerRoot,
    paths.teamRoot,
    paths.tasksRoot,
    paths.processesRoot,
    paths.controlRoot,
    paths.goalsRoot,
    paths.gitRoot,
    paths.codeIntelligenceRoot,
    paths.migrationsRoot,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
  }
  const tokensRoot = join(paths.stateRoot, 'tokens')
  mkdirSync(tokensRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(tokensRoot, 0o700)
}
