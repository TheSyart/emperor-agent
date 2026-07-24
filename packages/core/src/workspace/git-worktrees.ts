import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceOperationError } from './common'
import type {
  GitRepositoryIdentity,
  GitRepositoryResolver,
} from './git-repository'
import type { GitCommandResult } from './git-runner'

interface WorktreeLease {
  version: 1
  sessionId: string
  id: string
  path: string
  branch: string
  originalProjectRoot: string
  repositoryRoot: string
  commonDir: string
  startHead: string | null
  active: boolean
  createdAt: number
}

interface WorktreeState {
  version: 1
  leases: WorktreeLease[]
}

interface SubagentWorktreeLease {
  version: 1
  taskId: string
  sessionId: string
  path: string
  executionRoot: string
  repositoryRoot: string
  createdAt: number
}

interface SubagentWorktreeState {
  version: 1
  leases: Record<string, SubagentWorktreeLease>
}

export interface GitWorktreeSummary {
  id: string
  path: string
  branch: string | null
  head: string | null
  owned: boolean
  active: boolean
  locked: boolean
  prunable: boolean
}

export class WorkspaceBindingStore {
  private readonly path: string

  constructor(private readonly stateRoot: string) {
    this.path = join(stateRoot, 'git', 'worktree-leases.json')
  }

  resolve(sessionId: string, originalProjectRoot: string): string {
    const lease = this.read().leases.find(
      (item) => item.sessionId === sessionId && item.active,
    )
    return lease?.path || originalProjectRoot
  }

  active(sessionId: string): WorktreeLease | null {
    return (
      this.read().leases.find(
        (item) => item.sessionId === sessionId && item.active,
      ) || null
    )
  }

  leases(sessionId?: string): WorktreeLease[] {
    return this.read().leases.filter(
      (lease) => !sessionId || lease.sessionId === sessionId,
    )
  }

  saveLease(lease: WorktreeLease): void {
    const state = this.read()
    state.leases = state.leases
      .map((item) =>
        item.sessionId === lease.sessionId ? { ...item, active: false } : item,
      )
      .filter((item) => item.id !== lease.id)
    state.leases.push(lease)
    this.write(state)
  }

  deactivate(sessionId: string): void {
    const state = this.read()
    state.leases = state.leases.map((lease) =>
      lease.sessionId === sessionId ? { ...lease, active: false } : lease,
    )
    this.write(state)
  }

  remove(id: string): void {
    const state = this.read()
    state.leases = state.leases.filter((lease) => lease.id !== id)
    this.write(state)
  }

  private read(): WorktreeState {
    if (!existsSync(this.path)) return { version: 1, leases: [] }
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as WorktreeState
      if (value.version !== 1 || !Array.isArray(value.leases))
        throw new Error('invalid worktree lease store')
      const leases = value.leases.map((raw) => {
        if (
          !raw ||
          typeof raw !== 'object' ||
          raw.version !== 1 ||
          typeof raw.sessionId !== 'string' ||
          typeof raw.id !== 'string' ||
          typeof raw.path !== 'string' ||
          typeof raw.branch !== 'string' ||
          typeof raw.originalProjectRoot !== 'string' ||
          typeof raw.repositoryRoot !== 'string' ||
          typeof raw.commonDir !== 'string' ||
          typeof raw.active !== 'boolean' ||
          typeof raw.createdAt !== 'number'
        )
          throw new Error('invalid worktree lease')
        const lease: WorktreeLease = {
          ...raw,
          path: canonical(raw.path),
        }
        assertOwnedPath(this.stateRoot, lease.sessionId, lease)
        return lease
      })
      return {
        version: 1,
        leases,
      }
    } catch (error) {
      throw new WorkspaceOperationError(
        'git_worktree_lease_corrupt',
        'Session worktree lease 损坏；为避免切换到错误目录，Git 工作区已停止。',
        { cause: error },
      )
    }
  }

  private write(state: WorktreeState): void {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.path)
  }
}

export interface GitWorktreeManagerOptions {
  stateRoot: string
  subagentWorktreeRoot?: string
  bindings: WorkspaceBindingStore
  resolver: Pick<GitRepositoryResolver, 'resolve'>
  execute: (
    cwd: string,
    args: string[],
    options?: {
      allowedExitCodes?: number[]
      network?: boolean
    },
  ) => Promise<GitCommandResult>
  hasActiveWriter?: (sessionId: string) => boolean
}

export class GitWorktreeManager {
  readonly subagentWorktreeRoot: string
  readonly subagentManifestPath: string
  private readonly subagentLeases: SubagentWorktreeLeaseStore

  constructor(private readonly options: GitWorktreeManagerOptions) {
    this.subagentWorktreeRoot = canonical(
      options.subagentWorktreeRoot ??
        resolve(options.stateRoot, 'subagent-worktrees'),
    )
    this.subagentLeases = new SubagentWorktreeLeaseStore(
      this.subagentWorktreeRoot,
    )
    this.subagentManifestPath = this.subagentLeases.path
  }

  async list(
    sessionId: string,
    projectRoot: string,
  ): Promise<{ worktrees: GitWorktreeSummary[]; owned: GitWorktreeSummary[] }> {
    const identity = await this.options.resolver.resolve(projectRoot)
    const result = await this.options.execute(identity.worktreeRoot, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ])
    const leases = this.options.bindings.leases(sessionId)
    const worktrees = parseWorktreeList(result.stdout).map((entry) => {
      const lease = leases.find((item) => canonical(item.path) === entry.path)
      return {
        ...entry,
        owned: Boolean(lease),
        active: Boolean(lease?.active),
      }
    })
    return {
      worktrees,
      owned: worktrees.filter((entry) => entry.owned),
    }
  }

  async enter(input: {
    sessionId: string
    projectRoot: string
    name?: string
    startPoint?: string
    expectedRevision: string
    confirmed: true
  }): Promise<GitWorktreeSummary> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    if (this.options.bindings.active(input.sessionId))
      throw new WorkspaceOperationError(
        'git_worktree_already_active',
        '当前会话已经位于临时 worktree。',
      )
    const identity = await this.options.resolver.resolve(input.projectRoot)
    requireRepositoryRoot(identity)
    if (identity.transientState !== 'none')
      throw new WorkspaceOperationError(
        'git_transient_state',
        '仓库处于未完成的 Git 操作中，不能创建 worktree。',
      )
    const branch = validateWorktreeName(
      input.name || `emperor-${input.sessionId.slice(0, 12)}-${Date.now()}`,
    )
    const ownerRoot = resolve(
      this.options.stateRoot,
      'git',
      'worktrees',
      safeSegment(input.sessionId),
    )
    mkdirSync(ownerRoot, { recursive: true })
    const path = resolve(ownerRoot, safeSegment(branch))
    if (!isWithin(ownerRoot, path) || existsSync(path))
      throw new WorkspaceOperationError(
        'git_worktree_path_invalid',
        '临时 worktree 路径不可用。',
      )
    const startPoint = validateRef(input.startPoint || 'HEAD')
    const branchExists = await this.options.execute(
      identity.worktreeRoot,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { allowedExitCodes: [0, 1] },
    )
    const args =
      branchExists.exitCode === 0
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path, startPoint]
    await this.options.execute(identity.worktreeRoot, args)
    const lease: WorktreeLease = {
      version: 1,
      sessionId: input.sessionId,
      id: `worktree_${randomUUID()}`,
      path: canonical(path),
      branch,
      originalProjectRoot: identity.projectRoot,
      repositoryRoot: identity.worktreeRoot,
      commonDir: identity.commonDir,
      startHead: identity.headOid,
      active: true,
      createdAt: Date.now(),
    }
    this.options.bindings.saveLease(lease)
    return {
      id: lease.id,
      path: lease.path,
      branch,
      head: identity.headOid,
      owned: true,
      active: true,
      locked: false,
      prunable: false,
    }
  }

  async exit(input: {
    sessionId: string
    projectRoot: string
    action: 'keep' | 'remove'
    discardChanges: boolean
    expectedRevision: string
    confirmed: true
  }): Promise<{ action: 'keep' | 'remove'; path: string }> {
    requireConfirmed(input.confirmed)
    this.requireNoWriter(input.sessionId)
    const lease = this.options.bindings.active(input.sessionId)
    if (!lease)
      throw new WorkspaceOperationError(
        'git_worktree_not_owned',
        '当前会话没有可退出的 Emperor worktree。',
      )
    assertOwnedPath(this.options.stateRoot, input.sessionId, lease)
    if (input.action === 'keep') {
      this.options.bindings.deactivate(input.sessionId)
      return { action: 'keep', path: lease.path }
    }

    const status = await this.options.execute(lease.path, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    const dirty = Boolean(status.stdout)
    const unpushed =
      lease.startHead === null
        ? 0
        : Number.parseInt(
            (
              await this.options.execute(
                lease.path,
                ['rev-list', '--count', `${lease.startHead}..HEAD`],
                { allowedExitCodes: [0, 128] },
              )
            ).stdout.trim(),
            10,
          ) || 0
    if ((dirty || unpushed > 0) && !input.discardChanges)
      throw new WorkspaceOperationError(
        'git_worktree_has_changes',
        `临时 worktree 仍有${dirty ? '未提交文件' : ''}${dirty && unpushed ? '和' : ''}${unpushed ? `${unpushed} 个未合并提交` : ''}，拒绝删除。`,
      )
    await this.options.execute(lease.repositoryRoot, [
      'worktree',
      'remove',
      ...(input.discardChanges ? ['--force'] : []),
      lease.path,
    ])
    if (existsSync(lease.path))
      rmSync(lease.path, { recursive: true, force: true })
    this.options.bindings.remove(lease.id)
    return { action: 'remove', path: lease.path }
  }

  async acquireSubagent(input: {
    taskId: string
    sessionId: string
    sourceRoot: string
  }): Promise<{
    root: string
    cleanup: () => Promise<void>
  }> {
    const taskId = validateTaskId(input.taskId)
    if (this.subagentLeases.get(taskId))
      throw new WorkspaceOperationError(
        'subagent_worktree_unavailable',
        '该子代理已经持有隔离 worktree。',
      )
    mkdirSync(this.subagentWorktreeRoot, { recursive: true, mode: 0o700 })
    const path = canonical(resolve(this.subagentWorktreeRoot, taskId))
    assertSubagentOwnedPath(this.subagentWorktreeRoot, path)
    if (existsSync(path))
      throw new WorkspaceOperationError(
        'subagent_worktree_unavailable',
        '子代理隔离目录已经存在。',
      )
    const identity = await this.options.resolver.resolve(input.sourceRoot)
    await this.options.execute(identity.worktreeRoot, [
      'worktree',
      'add',
      '--detach',
      path,
      'HEAD',
    ])
    const executionRoot = identity.repositoryPrefix
      ? canonical(resolve(path, identity.repositoryPrefix))
      : path
    const lease: SubagentWorktreeLease = {
      version: 1,
      taskId,
      sessionId: input.sessionId,
      path,
      executionRoot,
      repositoryRoot: identity.worktreeRoot,
      createdAt: Date.now(),
    }
    try {
      this.subagentLeases.save(lease)
    } catch (error) {
      await this.removeSubagentWorktree(lease).catch(() => undefined)
      throw error
    }
    let cleanup: Promise<void> | null = null
    return {
      root: executionRoot,
      cleanup: async () => {
        if (!cleanup)
          cleanup = this.removeSubagentWorktree(lease).catch((error) => {
            cleanup = null
            throw error
          })
        await cleanup
      },
    }
  }

  async reconcileSubagents(): Promise<void> {
    for (const lease of this.subagentLeases.list()) {
      try {
        assertSubagentOwnedPath(this.subagentWorktreeRoot, lease.path)
        await this.removeSubagentWorktree(lease)
      } catch {
        // 保留 lease，下一次启动继续尝试；绝不清理无法验证归属的目录。
      }
    }
  }

  private async removeSubagentWorktree(
    lease: SubagentWorktreeLease,
  ): Promise<void> {
    assertSubagentOwnedPath(this.subagentWorktreeRoot, lease.path)
    try {
      await this.options.execute(lease.repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        lease.path,
      ])
    } catch (error) {
      if (existsSync(lease.path)) throw error
    }
    await this.options
      .execute(lease.repositoryRoot, ['worktree', 'prune'])
      .catch(() => undefined)
    if (existsSync(lease.path))
      rmSync(lease.path, { recursive: true, force: true })
    this.subagentLeases.remove(lease.taskId)
  }

  private requireNoWriter(sessionId: string): void {
    if (!this.options.hasActiveWriter?.(sessionId)) return
    throw new WorkspaceOperationError(
      'git_active_writer',
      '当前 Agent 正在修改项目，worktree 操作已暂停。',
    )
  }
}

class SubagentWorktreeLeaseStore {
  readonly path: string

  constructor(private readonly root: string) {
    this.path = resolve(root, '.leases.json')
  }

  get(taskId: string): SubagentWorktreeLease | null {
    return this.read().leases[taskId] ?? null
  }

  list(): SubagentWorktreeLease[] {
    return Object.values(this.read().leases)
  }

  save(lease: SubagentWorktreeLease): void {
    const state = this.read()
    state.leases[lease.taskId] = lease
    this.write(state)
  }

  remove(taskId: string): void {
    const state = this.read()
    if (!(taskId in state.leases)) return
    delete state.leases[taskId]
    this.write(state)
  }

  private read(): SubagentWorktreeState {
    if (!existsSync(this.path)) return { version: 1, leases: {} }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<
        string,
        unknown
      >
      if (raw.version !== 1)
        throw new Error('unsupported subagent worktree lease version')
      if (
        !raw.leases ||
        typeof raw.leases !== 'object' ||
        Array.isArray(raw.leases)
      )
        throw new Error('invalid subagent worktree leases')
      const leases: Record<string, SubagentWorktreeLease> = {}
      const rawLeases = raw.leases as Record<string, unknown>
      for (const [taskId, value] of Object.entries(rawLeases)) {
        validateTaskId(taskId)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('invalid subagent worktree lease')
        const record = value as Record<string, unknown>
        const repositoryRoot = String(record.repositoryRoot ?? '').trim()
        if (!repositoryRoot)
          throw new Error('subagent worktree lease is missing repository root')
        const path = canonical(
          String(record.path ?? resolve(this.root, taskId)),
        )
        assertSubagentOwnedPath(this.root, path)
        const executionRoot = canonical(String(record.executionRoot ?? path))
        if (!isWithin(path, executionRoot) && executionRoot !== path)
          throw new Error('subagent execution root escapes its worktree')
        leases[taskId] = {
          version: 1,
          taskId,
          sessionId: String(record.sessionId ?? ''),
          path,
          executionRoot,
          repositoryRoot: canonical(repositoryRoot),
          createdAt: Number(record.createdAt ?? 0),
        }
      }
      return { version: 1, leases }
    } catch (error) {
      throw new WorkspaceOperationError(
        'git_worktree_lease_corrupt',
        '子代理 worktree lease 损坏；为避免误删目录，自动创建与清理已停止。',
        { cause: error },
      )
    }
  }

  private write(state: SubagentWorktreeState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.path)
  }
}

function parseWorktreeList(
  raw: string,
): Array<Omit<GitWorktreeSummary, 'owned' | 'active'>> {
  const entries: Array<Omit<GitWorktreeSummary, 'owned' | 'active'>> = []
  let current: Omit<GitWorktreeSummary, 'owned' | 'active'> | undefined
  for (const token of raw.split('\0')) {
    if (!token) continue
    if (token.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = {
        id: '',
        path: canonical(token.slice('worktree '.length)),
        branch: null,
        head: null,
        locked: false,
        prunable: false,
      }
    } else if (current && token.startsWith('HEAD '))
      current.head = token.slice(5) || null
    else if (current && token.startsWith('branch '))
      current.branch = token.slice(7).replace(/^refs\/heads\//, '') || null
    else if (current && token === 'locked') current.locked = true
    else if (current && token === 'prunable') current.prunable = true
  }
  if (current) entries.push(current)
  return entries.map((entry) => ({ ...entry, id: entry.path }))
}

function requireRepositoryRoot(identity: GitRepositoryIdentity): void {
  if (identity.repositoryPrefix) {
    throw new WorkspaceOperationError(
      'git_repository_wide_operation',
      '当前 Build 项目是仓库子目录，不能创建仓库级 worktree。',
    )
  }
}

function assertOwnedPath(
  stateRoot: string,
  sessionId: string,
  lease: WorktreeLease,
): void {
  const ownerRoot = canonical(
    resolve(stateRoot, 'git', 'worktrees', safeSegment(sessionId)),
  )
  if (
    lease.sessionId !== sessionId ||
    !isWithin(ownerRoot, canonical(lease.path)) ||
    !lease.id.startsWith('worktree_')
  )
    throw new WorkspaceOperationError(
      'git_worktree_not_owned',
      '只能清理 Emperor 创建且 lease 可验证的 worktree。',
    )
}

function validateWorktreeName(value: string): string {
  const name = value.trim()
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name) ||
    name.includes('..') ||
    name.endsWith('/') ||
    name.startsWith('-')
  )
    throw new WorkspaceOperationError(
      'git_argument_invalid',
      'worktree 名称不合法。',
    )
  return name
}

function validateRef(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    /[\0\r\n~^:?*[]/.test(value) ||
    value.startsWith('-')
  )
    throw new WorkspaceOperationError(
      'git_argument_invalid',
      'Git 引用不合法。',
    )
  return value
}

function requireConfirmed(value: unknown): asserts value is true {
  if (value !== true)
    throw new WorkspaceOperationError(
      'git_confirmation_required',
      '该 worktree 操作需要明确确认。',
    )
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96)
}

function validateTaskId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new WorkspaceOperationError(
      'subagent_worktree_unavailable',
      '子代理任务标识不合法。',
    )
  return value
}

function assertSubagentOwnedPath(root: string, path: string): void {
  if (!isWithin(canonical(root), canonical(path)))
    throw new WorkspaceOperationError(
      'git_worktree_not_owned',
      '只能清理 Emperor 创建且 lease 可验证的子代理 worktree。',
    )
}

function canonical(path: string): string {
  const absolute = resolve(path)
  return existsSync(absolute) ? realpathSync(absolute) : absolute
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
