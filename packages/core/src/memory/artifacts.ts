import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryScope } from './patch'

export type MemoryArtifactKind =
  | 'user_profile'
  | 'global_memory'
  | 'project_memory'
  | 'daily_episode'
  | 'conversation_history'
  | 'runtime_event_log'
  | 'checkpoint'
  | 'prompt_snapshot'
  | 'history_archive'
  | 'model_call_audit'

export type MemoryVisibility =
  | 'always_injected'
  | 'chat_only'
  | 'build_only'
  | 'session_context'
  | 'retrieval_only'
  | 'runtime_only'
  | 'debug_only'
  | 'recovery_only'
  | 'never_model_visible'

export type MemoryMutability =
  | 'append_only'
  | 'managed_patch'
  | 'managed_rewrite'
  | 'replaceable_checkpoint'
  | 'derived'

export type MemoryWriter =
  | 'onboarding'
  | 'agent_loop'
  | 'user_tool'
  | 'compactor'
  | 'runtime'
  | 'system'

export interface MemoryArtifactMeta {
  artifactId: string
  kind: MemoryArtifactKind
  scope: MemoryScope
  visibility: MemoryVisibility
  mutability: MemoryMutability
  createdAt: string
  updatedAt: string
  version: number
  contentHash: string
  writers: MemoryWriter[]
  injectedIn: Array<'chat' | 'build'>
  path: string
}

export interface BuildMemoryArtifactsOptions {
  stateRoot: string
  memoryDir: string
  userFile: string
  sessionId?: string | null
  sessionRoot?: string | null
  historyFile?: string | null
  runtimeEventsFile?: string | null
  projectId?: string | null
  projectMemoryPath?: string | null
  episodeDate?: string | null
}

export function buildMemoryArtifacts(opts: BuildMemoryArtifactsOptions): MemoryArtifactMeta[] {
  const sessionId = clean(opts.sessionId)
  const sessionRoot = clean(opts.sessionRoot)
  const episodeDate = clean(opts.episodeDate)
  const items: MemoryArtifactMeta[] = [
    artifact({
      kind: 'user_profile',
      scope: { kind: 'user_profile' },
      visibility: 'always_injected',
      mutability: 'managed_patch',
      writers: ['onboarding', 'user_tool', 'compactor'],
      injectedIn: ['chat', 'build'],
      path: opts.userFile,
    }),
    artifact({
      kind: 'global_memory',
      scope: { kind: 'global' },
      visibility: 'chat_only',
      mutability: 'managed_patch',
      writers: ['user_tool', 'compactor'],
      injectedIn: ['chat'],
      path: join(opts.memoryDir, 'MEMORY.local.md'),
    }),
  ]
  if (opts.projectId && opts.projectMemoryPath) {
    items.push(artifact({
      kind: 'project_memory',
      scope: { kind: 'project', projectId: opts.projectId },
      visibility: 'build_only',
      mutability: 'managed_patch',
      writers: ['user_tool', 'compactor'],
      injectedIn: ['build'],
      path: opts.projectMemoryPath,
    }))
  }
  if (episodeDate) {
    items.push(artifact({
      kind: 'daily_episode',
      scope: { kind: 'episode', date: episodeDate },
      visibility: 'retrieval_only',
      mutability: 'append_only',
      writers: ['compactor'],
      injectedIn: [],
      path: join(opts.memoryDir, `${episodeDate}.md`),
    }))
  }
  if (sessionId && opts.historyFile) {
    items.push(artifact({
      kind: 'conversation_history',
      scope: { kind: 'session', sessionId },
      visibility: 'session_context',
      mutability: 'append_only',
      writers: ['agent_loop'],
      injectedIn: ['chat', 'build'],
      path: opts.historyFile,
    }))
    items.push(artifact({
      kind: 'model_call_audit',
      scope: { kind: 'session', sessionId },
      visibility: 'debug_only',
      mutability: 'append_only',
      writers: ['agent_loop'],
      injectedIn: [],
      path: opts.historyFile,
    }))
  }
  if (sessionId && opts.runtimeEventsFile) {
    items.push(artifact({
      kind: 'runtime_event_log',
      scope: { kind: 'session', sessionId },
      visibility: 'runtime_only',
      mutability: 'append_only',
      writers: ['runtime'],
      injectedIn: [],
      path: opts.runtimeEventsFile,
    }))
  }
  if (sessionId && sessionRoot) {
    items.push(artifact({
      kind: 'checkpoint',
      scope: { kind: 'session', sessionId },
      visibility: 'recovery_only',
      mutability: 'replaceable_checkpoint',
      writers: ['agent_loop'],
      injectedIn: [],
      path: join(sessionRoot, '_checkpoint.json'),
    }))
    items.push(artifact({
      kind: 'prompt_snapshot',
      scope: { kind: 'session', sessionId },
      visibility: 'debug_only',
      mutability: 'derived',
      writers: ['agent_loop'],
      injectedIn: [],
      path: join(sessionRoot, 'prompt-snapshots'),
    }))
    items.push(artifact({
      kind: 'history_archive',
      scope: { kind: 'session', sessionId },
      visibility: 'never_model_visible',
      mutability: 'append_only',
      writers: ['system'],
      injectedIn: [],
      path: join(sessionRoot, 'history_archive'),
    }))
  }
  return items
}

function artifact(input: Omit<MemoryArtifactMeta, 'artifactId' | 'createdAt' | 'updatedAt' | 'version' | 'contentHash'>): MemoryArtifactMeta {
  const digest = fileHash(input.path)
  const times = fileTimes(input.path)
  return {
    artifactId: `${input.kind}:${createHash('sha256').update(`${input.path}:${JSON.stringify(input.scope)}`, 'utf8').digest('hex').slice(0, 12)}`,
    version: 1,
    contentHash: digest,
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    ...input,
  }
}

function fileHash(path: string): string {
  if (!existsSync(path)) return ''
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return createHash('sha256').update(`${path}:${stat.mtimeMs}:${stat.size}`, 'utf8').digest('hex')
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

function fileTimes(path: string): { createdAt: string; updatedAt: string } {
  if (!existsSync(path)) return { createdAt: '', updatedAt: '' }
  try {
    const stat = statSync(path)
    return {
      createdAt: new Date(stat.birthtimeMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    }
  } catch {
    return { createdAt: '', updatedAt: '' }
  }
}

function clean(value: string | null | undefined): string {
  return String(value ?? '').trim()
}
