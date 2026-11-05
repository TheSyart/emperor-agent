/**
 * CG-01/D50: each group's collaboration files live in one Core-managed root.
 * Member directories are writable workspaces, `shared` is read-only to every
 * member, and only this host service can publish immutable public artifacts.
 * These directories are not Git worktrees and are never an integration queue.
 */
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { copyFileSync, constants } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { EmperorError } from '../errors'
import { mimeTypeForPath } from '../workspace/files'

export interface GroupWorkspaceInfo {
  root: string
  shared: string
}

export interface GroupWorkspaceAccess {
  workspaceRoot: string
  readOnlyRoots: readonly string[]
  /** Other members' private folders: unreadable and unwritable in every mode. */
  deniedRoots: readonly string[]
}

export interface GroupArtifact {
  artifactId: string
  artifactRef: string
  contactId: string
  name: string
  /** Present on new artifacts; pre-CG-04 logs are classified when listed. */
  mimeType?: string
  /** Relative to the group root; the private source path is never logged. */
  path: string
  size: number
  sha256: string
  taskId?: string
  at: number
}

export class GroupWorkspaceError extends EmperorError {
  constructor(message: string) {
    super(message, 'group_invalid')
  }
}

function segment(value: string, label: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new GroupWorkspaceError(`${label}无效`)
  return value
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`..${sep}`))
  )
}

function makeDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

export class GroupWorkspaceStore {
  private readonly groupsRoot: string

  constructor(options: { stateRoot: string }) {
    this.groupsRoot = join(
      realpathSync.native(resolve(options.stateRoot)),
      'groups',
    )
  }

  ensureGroup(groupId: string): GroupWorkspaceInfo {
    const root = join(this.groupsRoot, segment(groupId, '群编号'))
    const shared = join(root, 'shared')
    makeDir(join(root, 'members'))
    makeDir(shared)
    return { root, shared }
  }

  ensureMember(groupId: string, contactId: string): GroupWorkspaceAccess {
    const group = this.ensureGroup(groupId)
    const workspaceRoot = join(
      group.root,
      'members',
      segment(contactId, '联系人编号'),
    )
    makeDir(workspaceRoot)
    return this.access(groupId, contactId, true)
  }

  access(
    groupId: string,
    contactId: string,
    active: boolean,
  ): GroupWorkspaceAccess {
    const group = this.ensureGroup(groupId)
    const workspaceRoot = join(
      group.root,
      'members',
      segment(contactId, '联系人编号'),
    )
    makeDir(workspaceRoot)
    const membersRoot = join(group.root, 'members')
    const deniedRoots = readdirSync(membersRoot, { withFileTypes: true })
      .filter((entry) => entry.name !== contactId)
      .map((entry) => join(membersRoot, entry.name))
      .sort()
    return {
      workspaceRoot,
      readOnlyRoots: active ? [group.shared] : [workspaceRoot, group.shared],
      deniedRoots,
    }
  }

  publish(input: {
    groupId: string
    contactId: string
    sourcePath: string
    active: boolean
    taskId?: string
    at?: number
  }): GroupArtifact {
    if (!input.active)
      throw new GroupWorkspaceError('成员退出群聊后不能再发布成果')
    const own = this.ensureMember(input.groupId, input.contactId).workspaceRoot
    const source = realpathSync.native(resolve(input.sourcePath))
    if (!under(source, realpathSync.native(own)))
      throw new GroupWorkspaceError('只能发布本人工作区内的文件')
    const info = lstatSync(source)
    if (!info.isFile()) throw new GroupWorkspaceError('公开成果必须是普通文件')
    const bytes = readFileSync(source)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const artifactId = `art-${sha256}`
    const name = basename(source)
    const group = this.ensureGroup(input.groupId)
    const relativeDir = join('shared', 'artifacts', artifactId)
    const directory = join(group.root, relativeDir)
    makeDir(directory)
    const sharedRoot = realpathSync.native(group.shared)
    const canonicalDirectory = realpathSync.native(directory)
    if (!under(canonicalDirectory, sharedRoot))
      throw new GroupWorkspaceError('公开成果路径无效')
    const destination = join(canonicalDirectory, name)
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL)
    } catch (error) {
      if (lstatSync(destination).size !== info.size) throw error
      const existing = createHash('sha256')
        .update(readFileSync(destination))
        .digest('hex')
      if (existing !== sha256) throw error
    }
    return {
      artifactId,
      artifactRef: `artifact://${input.groupId}/${artifactId}/${encodeURIComponent(name)}`,
      contactId: input.contactId,
      name,
      mimeType: mimeTypeForPath(name),
      path: join(relativeDir, name),
      size: info.size,
      sha256,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      at: input.at ?? Date.now(),
    }
  }
}
