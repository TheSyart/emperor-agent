import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  basename,
  dirname,
} from 'node:path'
import { DelegationError } from './types'
import type { HardenedGitRunner } from '../../workspace/git-runner'
export interface ArtifactFile {
  path: string
  mode: number
  size: number
  sha256: string
  blob: string
  binary: boolean
}
export const ARTIFACT_FILE_LIMIT = 16 * 1024 * 1024,
  ARTIFACT_TOTAL_LIMIT = 128 * 1024 * 1024
export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function safeArtifactPath(path: string): void {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.includes('\uFFFD') ||
    isAbsolute(path) ||
    path
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
  )
    throw new DelegationError(
      'INVALID_PATH',
      'artifact path is not a safe workspace-relative file',
    )
}
export function excludedArtifact(path: string): string | undefined {
  const name = basename(path).toLowerCase()
  if (
    name.startsWith('.env') ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    [
      'auth.json',
      'credentials.json',
      '.credentials.json',
      '.claude.json',
    ].includes(name)
  )
    return 'secret-file'
  return undefined
}
export function binary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}
export class ArtifactStore {
  constructor(
    readonly root: string,
    readonly excludedRoots: string[] = [dirname(root)],
  ) {}
  blob(sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha))
      throw new DelegationError('ARTIFACT_CORRUPT', 'invalid blob digest')
    return join(this.root, 'blobs', sha)
  }
  put(path: string, bytes: Buffer, mode: number): ArtifactFile {
    safeArtifactPath(path)
    if (bytes.length > ARTIFACT_FILE_LIMIT)
      throw new DelegationError(
        'ARTIFACT_LIMIT',
        'artifact exceeds 16 MiB; original retained',
      )
    const sha = sha256(bytes),
      blob = this.blob(sha)
    mkdirSync(join(this.root, 'blobs'), { recursive: true, mode: 0o700 })
    if (!existsSync(blob))
      writeFileSync(blob, bytes, { flag: 'wx', mode: 0o600 })
    else if (sha256(readFileSync(blob)) !== sha)
      throw new DelegationError(
        'ARTIFACT_CORRUPT',
        'stored artifact blob changed',
      )
    return {
      path,
      mode: mode & 0o777,
      size: bytes.length,
      sha256: sha,
      blob,
      binary: binary(bytes),
    }
  }
  read(file: ArtifactFile): Buffer {
    safeArtifactPath(file.path)
    if (
      file.blob !== this.blob(file.sha256) ||
      file.size > ARTIFACT_FILE_LIMIT ||
      !lstatSync(file.blob).isFile()
    )
      throw new DelegationError(
        'ARTIFACT_CORRUPT',
        'blob reference escaped its content address',
      )
    const bytes = readFileSync(file.blob)
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new DelegationError(
        'ARTIFACT_CORRUPT',
        'blob does not match its receipt',
      )
    return bytes
  }
}
export function artifactTreeDigest(files: ArtifactFile[]): string {
  return sha256(
    JSON.stringify(
      [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })),
    ),
  )
}
export async function workspaceArtifacts(
  cwd: string,
  store: ArtifactStore,
  runner?: HardenedGitRunner,
): Promise<{
  files: ArtifactFile[]
  excluded: { path: string; reason: string }[]
  repositoryRoot?: string
  prefix?: string
}> {
  const root = realpathSync(cwd),
    excluded: { path: string; reason: string }[] = [],
    candidates: string[] = []
  const privateRoots = [...store.excludedRoots, store.root]
    .map((p) => (existsSync(p) ? realpathSync(p) : resolve(p)))
    .filter((p) => {
      const rel = relative(root, p)
      if (!rel)
        throw new DelegationError(
          'PRIVATE_WORKSPACE',
          'artifact state cannot be its own source workspace',
        )
      return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
    })
  const isPrivate = (path: string) =>
    privateRoots.some((p) => {
      const rel = relative(p, resolve(root, path))
      return (
        !rel ||
        (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
      )
    })
  let repositoryRoot: string | undefined, prefix: string | undefined
  const command = async (args: string[]) => {
    const result = await runner!.execute(root, args)
    if (result.stdoutTruncated)
      throw new DelegationError('ARTIFACT_LIMIT', 'Git inventory was truncated')
    return result.stdout
  }
  if (runner) {
    const probe = await runner.execute(root, ['rev-parse', '--show-toplevel'], {
      allowedExitCodes: [0, 128],
    })
    if (probe.exitCode === 0) {
      repositoryRoot = realpathSync(probe.stdout.trim())
      prefix = relative(repositoryRoot, root).split(sep).join('/')
    }
  }
  if (repositoryRoot) {
    const local = (p: string) =>
      !prefix
        ? p
        : p.startsWith(prefix + '/')
          ? p.slice(prefix.length + 1)
          : undefined
    for (const path of (
      await command([
        'ls-files',
        '--full-name',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ])
    )
      .split('\0')
      .filter(Boolean)) {
      const rel = local(path)
      if (rel) candidates.push(rel)
    }
    for (const path of (
      await command([
        'ls-files',
        '--full-name',
        '-z',
        '--others',
        '--ignored',
        '--directory',
        '--exclude-standard',
      ])
    )
      .split('\0')
      .filter(Boolean)) {
      const rel = local(path.replace(/\/$/, ''))
      if (rel)
        excluded.push({ path: rel, reason: excludedArtifact(rel) ?? 'ignored' })
    }
  } else {
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), {
        withFileTypes: true,
      })) {
        const path = dir ? dir + '/' + entry.name : entry.name
        if (entry.name === '.git') continue
        if (isPrivate(path)) {
          excluded.push({ path, reason: 'private-runtime' })
          continue
        }
        if (entry.isDirectory()) {
          if (['node_modules', '.cache', 'dist', 'build'].includes(entry.name))
            excluded.push({ path, reason: 'generated-directory' })
          else walk(path)
        } else candidates.push(path)
        if (candidates.length > 10000)
          throw new DelegationError(
            'ARTIFACT_LIMIT',
            'artifact count exceeds 10000',
          )
      }
    }
    walk('')
  }
  const files: ArtifactFile[] = []
  let total = 0
  for (const path of [...new Set(candidates)].sort()) {
    safeArtifactPath(path)
    if (isPrivate(path)) {
      excluded.push({ path, reason: 'private-runtime' })
      continue
    }
    const reason = excludedArtifact(path)
    if (reason) {
      excluded.push({ path, reason })
      continue
    }
    const absolute = resolve(root, path)
    let stat
    try {
      stat = lstatSync(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let parent = root,
      unsupported = false
    for (const part of path.split('/')) {
      parent = join(parent, part)
      if (
        lstatSync(parent).isSymbolicLink() ||
        (parent !== root && existsSync(join(parent, '.git')))
      ) {
        unsupported = true
        break
      }
    }
    if (unsupported || !stat.isFile()) {
      excluded.push({ path, reason: 'unsupported-file' })
      continue
    }
    if (
      stat.size > ARTIFACT_FILE_LIMIT ||
      (total += stat.size) > ARTIFACT_TOTAL_LIMIT ||
      files.length >= 10000
    )
      throw new DelegationError(
        'ARTIFACT_LIMIT',
        'artifact collection limit exceeded; source files retained',
      )
    const bytes = readFileSync(absolute),
      after = lstatSync(absolute)
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ino !== stat.ino
    )
      throw new DelegationError(
        'TREE_CHANGED',
        'workspace changed while collecting',
      )
    files.push(store.put(path, bytes, stat.mode))
  }
  return {
    files,
    excluded,
    ...(repositoryRoot ? { repositoryRoot, prefix } : {}),
  }
}
