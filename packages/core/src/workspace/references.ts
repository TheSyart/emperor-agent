import { randomBytes } from 'node:crypto'
import { ReferenceSiteIconService } from './reference-site-icon'
import { fileURLToPath } from 'node:url'
import type { WebFetchClient } from '../network/web-fetch-client'
import {
  ReferencePreviewService,
  type GitHubPreviewReader,
  type ReferencePreviewInput,
  type ReferencePreview,
} from './reference-preview'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { previewCanonicalFile, type FilePreviewResult } from './file-preview'
import {
  resolveOwnedProject,
  WorkspaceOperationError,
  type ResolveWorkspaceProject,
} from './common'

import type {
  ReferenceDescriptor,
  ResolveReferenceInput,
} from './reference-types'
export type {
  ReferenceKind,
  ReferenceAction,
  ReferenceDescriptor,
  ResolveReferenceInput,
} from './reference-types'

interface StoredReference {
  delegationId?: string
  sessionId: string
  sourceMessageId: string
  descriptor: ReferenceDescriptor
  canonicalPath?: string
}

export interface AttachmentReferenceTarget {
  root: string
  relativePath: string
  label: string
}

export interface WorkspaceReferenceServiceOptions {
  resolveProject: ResolveWorkspaceProject
  resolveFileRoot?: (sessionId: string) => string
  delegatedRoot?: (sessionId: string, delegationId: string) => string
  delegatedImageRoots?: (sessionId: string, delegationId: string) => string[]
  preferReveal?: (sessionId: string) => boolean
  maxEntries?: number
  authorizeSession?: (sessionId: string) => void
  webFetchClient?: WebFetchClient | null
  githubPreview?: GitHubPreviewReader
  resolveAttachment?: (attachmentId: string) => AttachmentReferenceTarget | null
}

export class WorkspaceReferenceService {
  private readonly delegatedRoot?: WorkspaceReferenceServiceOptions['delegatedRoot']
  private readonly delegatedImageRoots?: WorkspaceReferenceServiceOptions['delegatedImageRoots']
  private readonly resolveProject: ResolveWorkspaceProject
  private readonly maxEntries: number
  private readonly preferReveal: (sessionId: string) => boolean
  private readonly previews: ReferencePreviewService
  private readonly siteIcons: ReferenceSiteIconService
  private readonly references = new Map<string, StoredReference>()
  private readonly cache = new Map<string, string>()

  constructor(private readonly options: WorkspaceReferenceServiceOptions) {
    this.delegatedRoot = options.delegatedRoot
    this.delegatedImageRoots = options.delegatedImageRoots
    this.resolveProject = options.resolveProject
    this.maxEntries = options.maxEntries ?? 2_000
    this.preferReveal = options.preferReveal ?? (() => false)
    this.previews = new ReferencePreviewService({
      authorize: (input) => {
        return this.authorize(input.referenceId, input.sessionId)
      },
      webFetchClient: options.webFetchClient,
      githubPreview: options.githubPreview,
    })
    this.siteIcons = new ReferenceSiteIconService({
      authorize: (input) => this.authorize(input.referenceId, input.sessionId),
      webFetchClient: options.webFetchClient,
    })
  }

  siteIcon(input: ReferencePreviewInput) {
    return this.siteIcons.icon(input)
  }

  preview(
    input: ReferencePreviewInput,
    signal?: AbortSignal,
  ): Promise<ReferencePreview> {
    return this.previews.preview(input, signal)
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

    if (input.delegationId)
      this.delegatedRoot?.(input.sessionId, input.delegationId)
    if (/^attachment:/i.test(href)) return this.resolveAttachment(input, href)
    if (/^https?:\/\//i.test(href)) return this.resolveWeb(input, href)
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(href) &&
      !/^file:/i.test(href) &&
      !/^[^/\\:]+\.[^/\\:]+:[1-9]\d*(?::[1-9]\d*)?$/.test(href)
    )
      throw new WorkspaceOperationError(
        'reference_protocol_denied',
        '不支持该引用协议。',
      )

    const descriptor = this.resolveFile(input, href)
    const stored = this.references.get(descriptor.id)
    if (stored) stored.delegationId = input.delegationId
    return descriptor
  }

  delegationScope(referenceId: string, sessionId: string): string | undefined {
    this.authorize(referenceId, sessionId)
    return this.references.get(referenceId)?.delegationId
  }

  authorize(referenceId: string, sessionId: string): ReferenceDescriptor {
    this.options.authorizeSession?.(sessionId)
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
  /** Main-only image capability; callers still enforce an owned workspace. */
  previewPath(referenceId: string, sessionId: string): string {
    const descriptor = this.authorize(referenceId, sessionId)
    const stored = this.references.get(referenceId)!
    if (!descriptor.available || descriptor.directory || !stored.canonicalPath)
      throw new WorkspaceOperationError(
        'reference_image_unavailable',
        '图片文件不可用。',
      )
    return stored.canonicalPath
  }

  previewFile(input: {
    sessionId: string
    referenceId: string
  }): Promise<FilePreviewResult> {
    const descriptor = this.authorize(input.referenceId, input.sessionId)
    const path = this.references.get(input.referenceId)?.canonicalPath
    if (
      !descriptor.available ||
      !path ||
      !descriptor.actions.includes('preview')
    )
      throw new WorkspaceOperationError(
        'reference_action_denied',
        '该引用无法预览文件内容。',
      )
    if (descriptor.directory) {
      if (realpathSync(path) !== path)
        throw new WorkspaceOperationError(
          'reference_target_changed',
          '目录位置已改变。',
        )
      return Promise.resolve({
        id: `file:${path}`,
        name: basename(path),
        path,
        kind: 'directory',
        mimeType: 'inode/directory',
        bytes: 0,
        truncated: false,
        revealable: descriptor.actions.includes('reveal'),
      })
    }
    return previewCanonicalFile(path).then((value) => ({
      ...value,
      revealable: descriptor.actions.includes('reveal'),
    }))
  }

  private resolveAttachment(
    input: ResolveReferenceInput,
    href: string,
  ): ReferenceDescriptor {
    this.options.authorizeSession?.(input.sessionId)
    const attachmentId = href.slice('attachment:'.length)
    if (!/^att_\d{4}-\d{2}_[0-9a-f]{8}$/.test(attachmentId))
      throw new WorkspaceOperationError(
        'reference_attachment_invalid',
        '附件引用无效。',
      )
    const attachment = this.options.resolveAttachment?.(attachmentId)
    if (!attachment)
      throw new WorkspaceOperationError(
        'reference_attachment_unknown',
        '附件不存在或已被移除。',
      )
    const path = attachment.relativePath
    if (
      !path ||
      path.includes('\0') ||
      path.includes('\\') ||
      isAbsolute(path) ||
      path.split('/').includes('..')
    )
      throw new WorkspaceOperationError(
        'reference_attachment_invalid',
        '附件路径无效。',
      )
    const root = realpathSync(attachment.root)
    const requested = resolve(root, path)
    const exists = existsSync(requested)
    const canonical = exists ? realpathSync(requested) : requested
    if (!within(root, requested) || !within(root, canonical))
      throw new WorkspaceOperationError(
        'reference_attachment_invalid',
        '附件路径超出存储范围。',
      )
    const available = exists && statSync(canonical).isFile()
    return this.store(
      input.sessionId,
      input.sourceMessageId,
      {
        id: referenceId(),
        kind: 'external_file',
        label: cleanLabel(input.label, attachment.label),
        tooltip: canonical,
        available,
        actions: available ? ['reveal', 'preview'] : [],
      },
      available ? canonical : undefined,
      `attachment\0${input.sessionId}\0${input.sourceMessageId}\0${attachmentId}\0${canonical}`,
    )
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
    this.options.authorizeSession?.(input.sessionId)
    const projectRoot = realpathSync(
      input.delegationId && this.delegatedRoot
        ? this.delegatedRoot(input.sessionId, input.delegationId)
        : this.options.resolveFileRoot
          ? this.options.resolveFileRoot(input.sessionId)
          : resolveOwnedProject(this.resolveProject, input.sessionId)
              .projectRoot,
    )
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
    const nativeImageWithin =
      !!input.delegationId &&
      isAbsolute(target) &&
      /\.(png|jpe?g|gif|webp)$/i.test(canonicalTarget) &&
      (
        this.delegatedImageRoots?.(input.sessionId, input.delegationId) ?? []
      ).some((root) => within(root, canonicalTarget))
    const canonicalWithin =
      (lexicalWithin && within(projectRoot, canonicalTarget)) ||
      nativeImageWithin
    if (input.delegationId && !canonicalWithin)
      throw new WorkspaceOperationError(
        'reference_outside_project',
        '子智能体引用不能指向工作区外。',
      )
    const stats = exists ? statSync(canonicalTarget) : undefined
    const directory = stats?.isDirectory() === true
    const available = stats?.isFile() === true || directory
    const shape = {
      available,
      ...(directory ? { directory: true as const } : {}),
    }
    const fallback = basename(target) || target

    if (
      canonicalWithin &&
      !input.delegationId &&
      !this.preferReveal(input.sessionId)
    ) {
      const relativePath = toProjectPath(relative(projectRoot, lexicalTarget))
      const descriptor: ReferenceDescriptor = {
        id: referenceId(),
        kind: 'project_file',
        label: cleanLabel(input.label, fallback),
        tooltip: lexicalTarget,
        ...shape,
        relativePath,
        ...(line ? { line } : {}),
        actions: available ? ['open_files', 'preview', 'reveal'] : [],
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
          ...shape,
          actions: available ? ['reveal'] : [],
        },
        available ? canonicalTarget : undefined,
        `external\0${input.sessionId}\0${input.delegationId ?? ''}\0${input.sourceMessageId}\0${canonicalTarget}\0${line ?? 0}`,
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
        ...shape,
        actions: available ? ['reveal'] : [],
      },
      available ? canonicalTarget : undefined,
      `external\0${input.sessionId}\0${input.delegationId ?? ''}\0${input.sourceMessageId}\0${canonicalTarget}\0${line ?? 0}`,
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
    if (cached) {
      // Same binding, same id; what the target is now (a file may have been
      // created or removed since) comes from this resolution.
      cached.descriptor = { ...descriptor, id: cached.descriptor.id }
      cached.canonicalPath = canonicalPath
      return { ...cached.descriptor, actions: [...cached.descriptor.actions] }
    }
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
  try {
    let path = rawHref
    let fragmentLine: string | undefined
    let fileUrl: URL | undefined
    if (/^file:/i.test(rawHref)) {
      fileUrl = new URL(rawHref)
      if (fileUrl.search || fileUrl.username || fileUrl.password)
        throw new Error('invalid file URL')
      fragmentLine = fileUrl.hash.match(/^#L([1-9]\d*)$/i)?.[1]
      fileUrl.hash = ''
      path = fileUrl.pathname
    }
    const position = path.match(/#L([1-9]\d*)$|:([1-9]\d*)(?::([1-9]\d*))?$/i)
    const rawLine = fragmentLine ?? position?.[1] ?? position?.[2]
    if (position) path = path.slice(0, position.index)
    let target: string
    if (fileUrl) {
      fileUrl.pathname = path
      target = fileURLToPath(fileUrl)
    } else target = decodeURIComponent(path)
    const line = rawLine === undefined ? undefined : Number(rawLine)
    if (
      !target ||
      target.includes('\0') ||
      (line !== undefined && !Number.isSafeInteger(line))
    )
      throw new Error('invalid file target')
    return { target, ...(line === undefined ? {} : { line }) }
  } catch {
    throw new WorkspaceOperationError(
      'reference_target_invalid',
      '文件引用无效。',
    )
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
