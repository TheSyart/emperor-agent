import type { ChatSnapshot, ToolChatData } from '../../../conversation/types'
import { mcpServerOf } from '../../workspace/workspaceSources'
import { argsOf, metaOf, resultValue, webCard } from '../tools/toolModel'
import {
  displayResource,
  markdownResources,
  type DisplayResource,
  type ResourceProvenance,
  type ResourceRole,
} from './resourceModel'

export interface ResourceToolInfo {
  name: string
  source?: string
  server?: string
  plugin_id?: string
}
export interface ConversationResources {
  sources: DisplayResource[]
  outputs: DisplayResource[]
}
const LIMIT = 64
const KINDS = new Set<DisplayResource['kind']>([
  'web',
  'github',
  'file',
  'folder',
  'image',
  'attachment',
  'skill',
  'plugin',
  'mcp',
])
const ROLES = new Set<ResourceRole>(['source', 'output', 'observation'])
const PROVENANCE = new Set<ResourceProvenance>([
  'provided',
  'discovered',
  'read',
  'cited',
  'created',
  'observed',
  'used',
])
const CAPABILITY_LABEL = { skill: 'Skill', plugin: '插件', mcp: 'MCP 服务' }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function hasControls(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
}
function string(value: unknown, limit = 512): string | undefined {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= limit &&
    !hasControls(value)
    ? value.trim()
    : undefined
}
function provenance(role: ResourceRole): ResourceProvenance {
  return role === 'output'
    ? 'created'
    : role === 'observation'
      ? 'observed'
      : 'read'
}

/** Normalize UI identity only; retain the original href for Core authorization. */
function normalize(resource: DisplayResource): DisplayResource {
  let id = resource.id
  if (resource.kind === 'web' || resource.kind === 'github') {
    const url = new URL(resource.href)
    url.hash = ''
    if (resource.kind === 'github') {
      const parts = url.pathname.split('/')
      if (parts[1]) parts[1] = parts[1].toLowerCase()
      if (parts[2]) parts[2] = parts[2].toLowerCase()
      url.pathname = parts.join('/').replace(/\/$/, '') || '/'
    }
    id = `web:${url.toString()}`
  } else if (
    resource.kind === 'file' ||
    resource.kind === 'folder' ||
    (resource.kind === 'image' && !resource.attachmentId)
  ) {
    let path = resource.href
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURIComponent(new URL(path).pathname)
      } catch {
        /* Preserve malformed escapes. */
      }
    }
    path = path
      .replace(/\\/g, '/')
      .replace(/#L\d+(?:-L?\d+)?$/, '')
      .replace(/:\d+(?::\d+)?$/, '')
    const absolute = path.startsWith('/')
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (!part || part === '.') continue
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
      else if (part !== '..' || !absolute) parts.push(part)
    }
    id = `file:${absolute ? '/' : ''}${parts.join('/')}`
  }
  return { ...resource, id }
}

const completedMarkdown = new WeakMap<
  object,
  {
    text: string
    source: string
    resources: readonly DisplayResource[]
  }
>()

/** Parse immutable history once; entries are released with their data/block. */
function completedResources(
  identity: object,
  text: string,
  source: string,
): readonly DisplayResource[] {
  const cached = completedMarkdown.get(identity)
  if (cached && cached.text === text && cached.source === source)
    return cached.resources
  const resources = markdownResources(text, source).map(normalize)
  completedMarkdown.set(identity, { text, source, resources })
  return resources
}

function target(
  href: unknown,
  label: unknown,
  source: string,
  file = false,
): DisplayResource | null {
  const value = string(href, 8192)
  if (!value) return null
  try {
    if (hasControls(decodeURIComponent(value))) return null
  } catch {
    /* Preserve malformed escapes. */
  }
  if (/^file:\/\//i.test(value)) {
    try {
      if (new URL(value).hostname && new URL(value).hostname !== 'localhost')
        return null
    } catch {
      return null
    }
  }
  const resource = displayResource(value, string(label) ?? '', source)
  if (resource) return normalize(resource)
  // An authoritative file path may have no extension (LICENSE, Dockerfile).
  if (!file || /^[a-z][a-z\d+.-]*:/i.test(value)) return null
  return normalize({
    id: '',
    kind: 'file',
    href: value,
    label: string(label) ?? value.split(/[\\/]/).pop() ?? value,
    subtitle: value,
    sourceMessageId: source,
    role: 'source',
    provenance: 'read',
  })
}
function capability(
  kind: 'skill' | 'plugin' | 'mcp',
  id: string,
  label: string,
  source: string,
  origin: ResourceProvenance = 'used',
): DisplayResource {
  return {
    id: `${kind}:${id}`,
    kind,
    href: `${kind}:${id}`,
    label,
    subtitle: CAPABILITY_LABEL[kind],
    sourceMessageId: source,
    role: 'source',
    provenance: origin,
  }
}
function attachment(
  id: string,
  label: string,
  source: string,
  role: ResourceRole,
  mime?: string,
  bytes?: unknown,
): DisplayResource {
  return {
    id: `attachment:${id}`,
    href: `attachment:${id}`,
    attachmentId: id,
    label,
    kind: mime?.startsWith('image/') ? 'image' : 'attachment',
    subtitle: mime ?? '附件',
    sourceMessageId: source,
    role,
    provenance: provenance(role),
    ...(mime ? { mime } : {}),
    ...(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0
      ? { bytes }
      : {}),
  }
}
function observationTool(name: string): boolean {
  return (
    /^(?:ui_|desktop_|browser_)/.test(name) ||
    /(?:^|_)(?:screenshot|screen_capture)(?:_|$)/i.test(name)
  )
}
function explicitResources(data: ToolChatData): DisplayResource[] {
  const raw = metaOf(data)?.displayResources
  if (!Array.isArray(raw) || !data.result) return []
  return raw.slice(0, LIMIT).flatMap((value) => {
    const item = record(value)
    if (
      !item ||
      !KINDS.has(item.kind as DisplayResource['kind']) ||
      !ROLES.has(item.role as ResourceRole)
    )
      return []
    let role = item.role as ResourceRole
    if (
      role === 'output' &&
      (data.result!.isError || data.status !== 'settled')
    )
      return []
    const kind = item.kind as DisplayResource['kind']
    const label = string(item.title) ?? string(item.name) ?? string(item.label)
    const id = string(item.attachmentId)
    let resource: DisplayResource | null = null
    if (id && (kind === 'image' || kind === 'attachment')) {
      resource = attachment(
        id,
        label ?? id,
        data.callId,
        role,
        string(item.mime) ?? (kind === 'image' ? 'image/*' : undefined),
        item.bytes,
      )
    } else if (kind === 'skill' || kind === 'plugin' || kind === 'mcp') {
      const href = string(item.href, 8192)
      const identity = href?.startsWith(`${kind}:`)
        ? string(href.slice(kind.length + 1))
        : undefined
      if (identity)
        resource = capability(kind, identity, label ?? identity, data.callId)
    } else {
      resource = target(
        item.href,
        label,
        data.callId,
        kind === 'file' || kind === 'folder' || kind === 'image',
      )
      if (resource && kind === 'github' && resource.kind !== 'github') return []
      if (
        resource &&
        kind === 'web' &&
        resource.kind !== 'web' &&
        resource.kind !== 'github'
      )
        return []
      if (
        resource &&
        ['file', 'folder', 'image'].includes(kind) &&
        !['file', 'folder', 'image'].includes(resource.kind)
      )
        return []
      if (resource && kind === 'folder') resource.kind = 'folder'
    }
    if (!resource) return []
    const attachmentId = resource.attachmentId
    const image = data.result!.content.find(
      (block) =>
        block.type === 'image' &&
        block.attachment.attachmentId === attachmentId,
    )
    if (image?.type === 'image')
      resource = {
        ...resource,
        kind: 'image',
        mime: image.attachment.mediaType,
        bytes: image.attachment.bytes,
      }
    if (
      role === 'output' &&
      observationTool(data.name) &&
      resource.kind === 'image'
    )
      role = 'observation'
    return [
      {
        ...resource,
        role,
        provenance:
          role === 'observation'
            ? ('observed' as const)
            : PROVENANCE.has(item.provenance as ResourceProvenance)
              ? (item.provenance as ResourceProvenance)
              : provenance(role),
        ...(string(item.description, 4096)
          ? { description: string(item.description, 4096) }
          : {}),
      },
    ]
  })
}

/** Structured resource results only. Free-form logs and tool arguments are never mined. */
export function toolResources(data: ToolChatData): DisplayResource[] {
  const meta = metaOf(data)
  const screenshot = record(record(meta?.computerUse)?.screenshot)
  const auditId = observationTool(data.name)
    ? string(screenshot?.attachmentId)
    : undefined
  // GUI tools keep the original PNG in audit metadata. Any image content
  // is a copy prepared for model vision and must not become a second resource.
  const modelImageIds = new Set(
    (data.result?.content ?? []).flatMap((block) =>
      block.type === 'image' ? [block.attachment.attachmentId] : [],
    ),
  )
  const out = explicitResources(data).filter(
    (resource) =>
      !auditId ||
      !resource.attachmentId ||
      (resource.attachmentId !== auditId &&
        !modelImageIds.has(resource.attachmentId)),
  )
  if (auditId)
    out.push(
      attachment(auditId, '截图', data.callId, 'observation', 'image/png'),
    )
  const add = (
    resource: DisplayResource | null,
    origin: ResourceProvenance,
  ) => {
    if (
      resource &&
      !out.some(
        (item) => item.id === resource.id && item.role === resource.role,
      )
    )
      out.push({ ...resource, provenance: origin })
  }
  if (data.result && !data.result.isError && data.status === 'settled') {
    if (data.name === 'web_search') {
      for (const source of webCard(data)?.sources.slice(0, LIMIT) ?? []) {
        const resource = target(source.url, source.title, data.callId)
        if (resource && (resource.kind === 'web' || resource.kind === 'github'))
          out.push({
            ...resource,
            provenance: 'discovered',
            ...(source.snippet ? { description: source.snippet } : {}),
          })
      }
    } else if (data.name === 'web_fetch') {
      const resource = target(
        meta?.url ?? argsOf(data).url,
        meta?.title,
        data.callId,
      )
      if (resource && (resource.kind === 'web' || resource.kind === 'github'))
        add(resource, 'read')
    } else if (data.name === 'read') {
      const resource = target(meta?.path, undefined, data.callId, true)
      if (resource && ['file', 'folder', 'image'].includes(resource.kind))
        add(resource, 'read')
    } else if (data.name === 'write' && meta?.operation === 'create') {
      const resource = target(meta.path, undefined, data.callId, true)
      if (resource && ['file', 'folder', 'image'].includes(resource.kind))
        add({ ...resource, role: 'output' }, 'created')
    } else if (data.name.startsWith('mcp_') && data.name !== 'mcp_config') {
      // MCP metadata and parsed JSON provide structure. Do not scan arbitrary text for URLs.
      const readStructured = (
        value: unknown,
        depth = 0,
        allowWeb = false,
      ): void => {
        if (depth > 3 || out.length >= LIMIT) return
        if (Array.isArray(value)) {
          for (const item of value.slice(0, LIMIT))
            readStructured(item, depth + 1, allowWeb)
          return
        }
        const item = record(value)
        if (!item) return
        const href =
          string(item.html_url, 8192) ??
          string(item.web_url, 8192) ??
          string(item.url, 8192)
        const resource = target(href, item.title ?? item.name, data.callId)
        if (
          resource &&
          (resource.kind === 'github' || (allowWeb && resource.kind === 'web'))
        )
          add(resource, 'read')
        for (const key of [
          'resource',
          'resources',
          'items',
          'results',
          'repository',
          'pull_request',
          'issue',
          'release',
          'commit',
        ])
          if (item[key]) readStructured(item[key], depth + 1, allowWeb)
      }
      readStructured(meta, 0, true)
      readStructured(resultValue(data))
    }
  }
  for (const block of data.result?.content ?? []) {
    if (block.type !== 'image' || auditId) continue
    const id = string(block.attachment.attachmentId)
    if (!id || out.some((item) => item.attachmentId === id)) continue
    out.push(
      attachment(
        id,
        id,
        data.callId,
        'observation',
        block.attachment.mediaType,
      ),
    )
  }
  return out
}

/** Resources from the currently loaded window, deduplicated per role and identity. */
export function resourcesFromSnapshot(
  snapshot: ChatSnapshot | null | undefined,
  options: { tools?: readonly ResourceToolInfo[] } = {},
): ConversationResources {
  if (!snapshot) return { sources: [], outputs: [] }
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
  const byId = new Map<string, { resource: DisplayResource; last: number }>()
  const use = (
    resource: DisplayResource,
    nodeKey: string,
    position: number,
  ) => {
    const key = `${resource.role}:${resource.id}`
    const previous = byId.get(key)
    const uses = [
      ...(previous?.resource.uses ?? []),
      {
        nodeKey,
        sourceMessageId: resource.sourceMessageId,
        provenance: resource.provenance,
      },
    ]
    byId.set(key, {
      resource: { ...previous?.resource, ...resource, uses },
      last: position,
    })
  }
  snapshot.order.forEach((key, position) => {
    const node = snapshot.nodes.get(key)
    if (!node || node.visibility === 'hidden') return
    const add = (resource: DisplayResource | null) => {
      if (resource) use(resource, key, position)
    }
    if (node.kind === 'user') {
      for (const resource of completedResources(
        node.data,
        node.data.text,
        node.data.messageId,
      ))
        add({ ...resource, provenance: 'provided' })
      for (const value of node.data.attachments) {
        const id = string(value.id) ?? string(value.attachmentId)
        if (id)
          add({
            ...attachment(
              id,
              string(value.name) ?? id,
              node.data.messageId,
              'source',
              string(value.mime),
              value.bytes ?? value.size,
            ),
            provenance: 'provided',
          })
      }
      const descriptors = new Set(
        node.data.attachments.map(
          (value) => string(value.id) ?? string(value.attachmentId),
        ),
      )
      for (const block of node.data.content) {
        if (
          block.type !== 'image' ||
          descriptors.has(block.attachment.attachmentId)
        )
          continue
        const id = string(block.attachment.attachmentId)
        if (id)
          add({
            ...attachment(
              id,
              id,
              node.data.messageId,
              'source',
              block.attachment.mediaType,
            ),
            provenance: 'provided',
          })
      }
      for (const reference of node.data.references ?? [])
        if (string(reference.id))
          add(
            capability(
              reference.kind,
              reference.id,
              reference.label,
              node.data.messageId,
              'provided',
            ),
          )
    } else if (node.kind === 'assistant') {
      if (node.data.status === 'running') return
      for (const block of node.data.blocks)
        if (block.kind === 'text')
          for (const resource of completedResources(
            block,
            block.text,
            node.data.messageId ?? node.id,
          ))
            add(resource)
    } else if (node.kind === 'tool') {
      const data = node.data
      for (const resource of toolResources(data)) add(resource)
      if (data.name === 'skill') {
        const name = string(metaOf(data)?.name) ?? string(argsOf(data).name)
        if (name) add(capability('skill', name, name, data.callId))
      }
      const server = mcpServerOf(data.name, data.result?.meta, tools)
      if (server) add(capability('mcp', server, server, data.callId))
      const plugin = string(tools.get(data.name)?.plugin_id)
      if (plugin) add(capability('plugin', plugin, plugin, data.callId))
    } else if (node.kind === 'context' && node.data.origin === 'message') {
      const kind =
        node.data.producer === 'skill-invocation'
          ? 'skill'
          : node.data.producer === 'plugin-invocation'
            ? 'plugin'
            : null
      const id =
        kind && node.data.summary?.startsWith(`${kind}:`)
          ? string(node.data.summary.slice(kind.length + 1))
          : undefined
      if (kind && id) add(capability(kind, id, id, node.data.messageId))
    } else if (node.kind === 'turnFiles' && node.data.status === 'recorded') {
      for (const file of node.data.files) {
        if (
          file.status !== 'added' ||
          node.data.reverted?.reverted.includes(file.path)
        )
          continue
        const resource = target(file.path, undefined, node.id, true)
        if (resource)
          add({ ...resource, role: 'output', provenance: 'created' })
      }
    }
  })
  const sorted = [...byId.values()]
    .sort((a, b) => b.last - a.last)
    .map((item) => item.resource)
  return {
    sources: sorted.filter((item) => item.role !== 'output'),
    outputs: sorted.filter((item) => item.role === 'output'),
  }
}
