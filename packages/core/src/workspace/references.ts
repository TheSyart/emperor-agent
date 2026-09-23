import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  resolveOwnedProject,
  WorkspaceOperationError,
  type ResolveWorkspaceProject,
} from './common'

export type ReferenceKind = 'project_file' | 'external_file' | 'web'

export type ReferenceAction = 'open_files' | 'reveal' | 'open_external'

export interface ReferenceDescriptor {
  id: string
  kind: ReferenceKind
  label: string
  tooltip: string
  available: boolean
  relativePath?: string
  line?: number
  actions: ReferenceAction[]
}

export interface ResolveReferenceInput {
  sessionId: string
  sourceMessageId: string
  href: string
  label: string
}

interface StoredReference {
  sessionId: string
  sourceMessageId: string
  descriptor: ReferenceDescriptor
  canonicalPath?: string
}

export interface WorkspaceReferenceServiceOptions {
  resolveProject: ResolveWorkspaceProject
  maxEntries?: number
}

export class WorkspaceReferenceService {
  private readonly resolveProject: ResolveWorkspaceProject
  private readonly maxEntries: number
  private readonly references = new Map<string, StoredReference>()
  private readonly cache = new Map<string, string>()

  constructor(options: WorkspaceReferenceServiceOptions) {
    this.resolveProject = options.resolveProject
    this.maxEntries = options.maxEntries ?? 2_000
  }

  resolve(input: ResolveReferenceInput): ReferenceDescriptor {
    const sourceMessageId = String(input.sourceMessageId ?? '').trim()
    if (!sourceMessageId)
      throw new WorkspaceOperationError(
        'reference_source_invalid',
        '引用来源无效。',
      )
    const href = String(input.href ?? '').trim()
    if (!href || href.includes('\0'))
      throw new WorkspaceOperationError(
        'reference_target_invalid',
        '引用目标无效。',
      )

    if (/^https?:\/\//i.test(href)) return this.resolveWeb(input, href)
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href))
      throw new WorkspaceOperationError(
        'reference_protocol_denied',
        '不支持该引用协议。',
      )

    return this.resolveFile(input, href)
  }

  authorize(referenceId: string, sessionId: string): ReferenceDescriptor {
    const stored = this.references.get(referenceId)
    if (!stored)
      throw new WorkspaceOperationError(
        'reference_unknown',
        '引用已失效，请重新打开消息。',
      )
    if (stored.sessionId !== sessionId)
      throw new WorkspaceOperationError(
        'reference_session_mismatch',
        '当前会话不拥有该引用。',
      )
    return { ...stored.descriptor, actions: [...stored.descriptor.actions] }
  }

  revealPath(referenceId: string, sessionId: string): string {
    const descriptor = this.authorize(referenceId, sessionId)
    const stored = this.references.get(referenceId)!
    if (!descriptor.actions.includes('reveal') || !stored.canonicalPath)
      throw new WorkspaceOperationError(
        'reference_action_denied',
        '该引用不允许在文件管理器中定位。',
      )
    return stored.canonicalPath
  }

  private resolveWeb(
    input: ResolveReferenceInput,
    href: string,
  ): ReferenceDescriptor {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      throw new WorkspaceOperationError(
        'reference_url_invalid',
        '网站地址无效。',
      )
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new WorkspaceOperationError(
        'reference_protocol_denied',
        '不支持该引用协议。',
      )
    if (url.username || url.password)
      throw new WorkspaceOperationError(
        'reference_url_credentials_denied',
        '网站地址不能包含凭据。',
      )
    const normalized = url.toString()
    if (url.protocol !== 'https:')
      throw new WorkspaceOperationError(
        'reference_protocol_denied',
        '普通网站引用必须使用 HTTPS。',
      )
    const descriptor: ReferenceDescriptor = {
      id: referenceId(),
      kind: 'web',
      label: cleanLabel(input.label, url.hostname),
      tooltip: normalized,
      available: true,
      actions: ['open_external'],
    }
    return this.store(
      input.sessionId,
      input.sourceMessageId,
      descriptor,
      undefined,
      `web\0${input.sessionId}\0${input.sourceMessageId}\0${normalized}`,
    )
  }

  private resolveFile(
    input: ResolveReferenceInput,
    rawHref: string,
  ): ReferenceDescriptor {
    const { target, line } = fileTarget(rawHref)
    const scope = resolveOwnedProject(this.resolveProject, input.sessionId)
    const projectRoot = realpathSync(scope.projectRoot)
    if (!isAbsolute(target) && escapesProject(target))
      throw new WorkspaceOperationError(
        'reference_outside_project',
        '相对文件引用不能指向项目外。',
      )

    const requestedTarget = isAbsolute(target)
      ? target
      : resolve(projectRoot, target)
    const lexicalTarget = existsSync(requestedTarget)
      ? realpathSync(requestedTarget)
      : requestedTarget
    const lexicalWithin = within(projectRoot, lexicalTarget)
    const exists = existsSync(lexicalTarget)
    const canonicalTarget = exists ? realpathSync(lexicalTarget) : lexicalTarget
    const canonicalWithin =
      lexicalWithin && within(projectRoot, canonicalTarget)
    const fileAvailable = exists && statSync(canonicalTarget).isFile()
    const fallback = basename(target) || target

    if (canonicalWithin) {
      const relativePath = toProjectPath(relative(projectRoot, lexicalTarget))
      const descriptor: ReferenceDescriptor = {
        id: referenceId(),
        kind: 'project_file',
        label: cleanLabel(input.label, fallback),
        tooltip: lexicalTarget,
        available: fileAvailable,
        relativePath,
        ...(line ? { line } : {}),
        actions: fileAvailable ? ['open_files'] : [],
      }
      return this.store(
        input.sessionId,
        input.sourceMessageId,
        descriptor,
        canonicalTarget,
        `file\0${input.sessionId}\0${input.sourceMessageId}\0${projectRoot}\0${canonicalTarget}\0${line ?? 0}`,
      )
    }

    if (!isAbsolute(target) && within(projectRoot, requestedTarget))
      return this.store(
        input.sessionId,
        input.sourceMessageId,
        {
          id: referenceId(),
          kind: 'external_file',
          label: cleanLabel(input.label, fallback),
          tooltip: canonicalTarget,
          available: fileAvailable,
          actions: fileAvailable ? ['reveal'] : [],
        },
        fileAvailable ? canonicalTarget : undefined,
        `external\0${input.sessionId}\0${input.sourceMessageId}\0${canonicalTarget}\0${line ?? 0}`,
      )

    if (!isAbsolute(target))
      throw new WorkspaceOperationError(
        'reference_outside_project',
        '相对文件引用不能指向项目外。',
      )

    return this.store(
      input.sessionId,
      input.sourceMessageId,
      {
        id: referenceId(),
        kind: 'external_file',
        label: cleanLabel(input.label, fallback),
        tooltip: canonicalTarget,
        available: fileAvailable,
        actions: fileAvailable ? ['reveal'] : [],
      },
      fileAvailable ? canonicalTarget : undefined,
      `external\0${input.sessionId}\0${input.sourceMessageId}\0${canonicalTarget}\0${line ?? 0}`,
    )
  }

  private store(
    sessionId: string,
    sourceMessageId: string,
    descriptor: ReferenceDescriptor,
    canonicalPath?: string,
    cacheKey?: string,
  ): ReferenceDescriptor {
    const cachedId = cacheKey ? this.cache.get(cacheKey) : undefined
    const cached = cachedId ? this.references.get(cachedId) : undefined
    if (cached)
      return { ...cached.descriptor, actions: [...cached.descriptor.actions] }
    this.references.set(descriptor.id, {
      sessionId,
      sourceMessageId,
      descriptor,
      canonicalPath,
    })
    if (cacheKey) this.cache.set(cacheKey, descriptor.id)
    while (this.references.size > this.maxEntries) {
      const oldest = this.references.keys().next().value as string | undefined
      if (!oldest) break
      this.references.delete(oldest)
      for (const [key, id] of this.cache) {
        if (id === oldest) this.cache.delete(key)
      }
    }
    return { ...descriptor, actions: [...descriptor.actions] }
  }
}

function fileTarget(rawHref: string): { target: string; line?: number } {
  const decoded = /^file:/i.test(rawHref)
    ? decodeURIComponent(new URL(rawHref).pathname)
    : decodeURIComponent(rawHref)
  const match = decoded.match(/#L([1-9]\d*)$/i)
  return {
    target: match ? decoded.slice(0, match.index) : decoded,
    ...(match ? { line: Number(match[1]) } : {}),
  }
}

function escapesProject(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return normalized === '..' || normalized.startsWith('../')
}

function within(root: string, target: string): boolean {
  return (
    target === root ||
    target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  )
}

function toProjectPath(value: string): string {
  return value.split(sep).join('/')
}

function cleanLabel(value: string, fallback: string): string {
  const label = String(value ?? '').trim()
  return (label || fallback).slice(0, 500)
}

function referenceId(): string {
  return `ref_${randomBytes(12).toString('hex')}`
}
