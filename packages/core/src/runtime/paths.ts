import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type StateRootSource = 'explicit' | 'env' | 'default'

export interface RuntimePaths {
  runtimeRoot: string
  stateRoot: string
  stateRootSource: StateRootSource
  templatesDir: string
  skillsDir: string
  assetsDir: string
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
}

export interface RuntimePathOptions {
  stateRoot?: string | null
  templatesDir?: string | null
}

/** Default global private state root: `~/.emperor-agent`. Pure function of `homedir()` — never touches disk. */
export function defaultStateRoot(): string {
  return join(homedir(), '.emperor-agent')
}

function resolveStateRoot(opts: RuntimePathOptions): {
  stateRoot: string
  source: StateRootSource
} {
  if (opts.stateRoot)
    return { stateRoot: resolve(opts.stateRoot), source: 'explicit' }
  const envDir = process.env.EMPEROR_CONFIG_DIR
  if (envDir) return { stateRoot: resolve(envDir), source: 'env' }
  return { stateRoot: resolve(defaultStateRoot()), source: 'default' }
}

export function resolveRuntimePaths(
  root: string,
  opts: RuntimePathOptions = {},
): RuntimePaths {
  const runtimeRoot = resolve(root)
  const { stateRoot, source: stateRootSource } = resolveStateRoot(opts)
  const templatesDir = resolve(
    opts.templatesDir || join(runtimeRoot, 'templates'),
  )
  return {
    runtimeRoot,
    stateRoot,
    stateRootSource,
    templatesDir,
    skillsDir: join(runtimeRoot, 'skills'),
    assetsDir: join(runtimeRoot, 'assets'),
    memoryRoot: join(stateRoot, 'memory'),
    sessionsRoot: join(stateRoot, 'sessions'),
    projectsRoot: join(stateRoot, 'projects'),
    attachmentsRoot: join(stateRoot, 'memory', 'attachments'),
    mediaRoot: join(stateRoot, 'memory', 'media'),
    tokensFile: join(stateRoot, 'tokens', 'tokens.jsonl'),
    schedulerRoot: join(stateRoot, 'scheduler'),
    teamRoot: join(stateRoot, 'team'),
    tasksRoot: join(stateRoot, 'tasks'),
    processesRoot: join(stateRoot, 'processes'),
    controlRoot: join(stateRoot, 'control'),
  }
}

export function ensureRuntimeStateDirs(paths: RuntimePaths): void {
  for (const dir of [
    paths.stateRoot,
    paths.memoryRoot,
    paths.sessionsRoot,
    paths.projectsRoot,
    paths.attachmentsRoot,
    paths.mediaRoot,
    paths.schedulerRoot,
    paths.teamRoot,
    paths.tasksRoot,
    paths.processesRoot,
    paths.controlRoot,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  mkdirSync(join(paths.stateRoot, 'tokens'), { recursive: true })
}
