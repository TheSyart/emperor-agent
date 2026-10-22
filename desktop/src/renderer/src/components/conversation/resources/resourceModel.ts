import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import { documentGlyph } from '../../../documentKind'

export type ResourceRole = 'source' | 'output' | 'observation'
export type ResourceProvenance =
  'provided' | 'discovered' | 'read' | 'cited' | 'created' | 'observed' | 'used'
export interface GitHubResource {
  type:
    | 'repository'
    | 'pull_request'
    | 'issue'
    | 'commit'
    | 'release'
    | 'run'
    | 'page'
  repo?: string
  number?: number
  runId?: number
}
export interface DisplayResource {
  id: string
  kind:
    | 'web'
    | 'github'
    | 'file'
    | 'folder'
    | 'image'
    | 'attachment'
    | 'skill'
    | 'plugin'
    | 'mcp'
  href: string
  label: string
  subtitle: string
  sourceMessageId: string
  role: ResourceRole
  provenance: ResourceProvenance
  github?: GitHubResource
  description?: string
  status?: string
  attachmentId?: string
  mime?: string
  bytes?: number
  available?: boolean
  uses?: Array<{
    nodeKey: string
    sourceMessageId: string
    provenance: ResourceProvenance
  }>
}

const markdown = new MarkdownIt({ html: false, linkify: true })
const validateLink = markdown.validateLink.bind(markdown)
markdown.validateLink = (url) => validateLink(url) || url.startsWith('file://')
const TYPE_LABEL: Record<GitHubResource['type'], string> = {
  repository: '仓库',
  pull_request: 'Pull Request',
  issue: '议题',
  commit: '提交',
  release: '发布',
  run: 'CI',
  page: '网页',
}
export const PROVENANCE_LABEL: Record<ResourceProvenance, string> = {
  provided: '提供的参考',
  discovered: '搜索命中',
  read: '已查看',
  cited: '已引用',
  created: '已生成',
  observed: '观察记录',
  used: '已使用',
}

/** UI identity only. Opening a local target is always authorized by Core. */
export function displayResource(
  href: string,
  label: string,
  sourceMessageId: string,
): DisplayResource | null {
  if (!href || href.includes('\0')) return null
  let target = href
  try {
    target = decodeURIComponent(href)
  } catch {
    /* Keep malformed escapes as text. */
  }
  const base = {
    href,
    sourceMessageId,
    role: 'source' as const,
    provenance: 'cited' as const,
  }
  if (/^https?:\/\//i.test(href)) {
    let url: URL
    try {
      url = new URL(href)
    } catch {
      return null
    }
    if (url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    const authored =
      label.trim() && label.trim() !== href && label.trim() !== target
    const fallback =
      url.host +
      (url.pathname === '/' ? '' : url.pathname) +
      url.search +
      url.hash
    const id = `web:${url.toString()}`
    if (host === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean)
      const repo =
        parts.length >= 2 &&
        /^[\w.-]+$/.test(parts[0]!) &&
        /^[\w.-]+$/.test(parts[1]!)
          ? `${parts[0]}/${parts[1]}`
          : undefined
      let type: GitHubResource['type'] =
        repo && parts.length === 2 ? 'repository' : 'page'
      let suffix = ''
      let number: number | undefined
      let runId: number | undefined
      const positive = (text?: string) =>
        text && /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))
          ? Number(text)
          : undefined
      if (
        repo &&
        parts.length === 4 &&
        parts[2] === 'pull' &&
        positive(parts[3])
      ) {
        type = 'pull_request'
        number = positive(parts[3])
        suffix = `PR #${number}`
      }
      if (
        repo &&
        parts.length === 4 &&
        parts[2] === 'issues' &&
        positive(parts[3])
      ) {
        type = 'issue'
        number = positive(parts[3])
        suffix = `Issue #${number}`
      }
      if (
        repo &&
        parts.length === 4 &&
        parts[2] === 'commit' &&
        /^[a-f\d]{7,40}$/i.test(parts[3]!)
      ) {
        type = 'commit'
        suffix = parts[3]!.slice(0, 7)
      }
      if (repo && parts[2] === 'releases' && parts[3] === 'tag' && parts[4]) {
        type = 'release'
        try {
          suffix = decodeURIComponent(parts.slice(4).join('/'))
        } catch {
          suffix = parts[4]
        }
      }
      if (
        repo &&
        parts.length === 5 &&
        parts[2] === 'actions' &&
        parts[3] === 'runs' &&
        positive(parts[4])
      ) {
        type = 'run'
        runId = positive(parts[4])
        suffix = `CI #${runId}`
      }
      return {
        ...base,
        id,
        kind: 'github',
        label: authored
          ? label
          : repo
            ? repo + (suffix ? ` · ${suffix}` : '')
            : fallback,
        subtitle: `GitHub · ${TYPE_LABEL[type]}`,
        github: {
          type,
          ...(repo ? { repo } : {}),
          ...(number ? { number } : {}),
          ...(runId ? { runId } : {}),
        },
      }
    }
    return {
      ...base,
      id,
      kind: 'web',
      label: authored ? label : fallback,
      subtitle: url.host,
    }
  }
  const fileCandidate = target.replace(
    /(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*)$/i,
    '',
  )
  const isFile =
    /^file:\/\//i.test(fileCandidate) ||
    fileCandidate.startsWith('/') ||
    /^[a-z]:[\\/]/i.test(fileCandidate) ||
    (!/^[a-z][a-z\d+.-]*:/i.test(fileCandidate) &&
      (/(?:^|[\\/])[^?#]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?(?:#L\d+)?$/i.test(
        fileCandidate,
      ) ||
        /[\\/]$/.test(fileCandidate)))
  if (!isFile) return null
  const path = target.replace(/^file:\/\//i, '').replace(/#L(\d+)$/, ':$1')
  const name =
    path
      .replace(/[\\/]$/, '')
      .split(/[\\/]/)
      .pop() || path
  const glyph = documentGlyph(target)
  const readable =
    label.trim() &&
    label.trim() !== target &&
    label.trim() !== href &&
    !/[\\/]/.test(label)
  return {
    ...base,
    id: `file:${target}`,
    kind:
      glyph.kind === 'folder'
        ? 'folder'
        : glyph.kind === 'image'
          ? 'image'
          : 'file',
    label: readable ? label : name,
    subtitle: path,
  }
}

function inlineResources(
  children: readonly Token[],
  source: string,
): DisplayResource[] {
  const out: DisplayResource[] = []
  for (let i = 0; i < children.length; i++) {
    const token = children[i]!
    if (token.type !== 'link_open') continue
    let label = ''
    for (
      let j = i + 1;
      j < children.length && children[j]!.type !== 'link_close';
      j++
    )
      label += children[j]!.content
    const href =
      token.markup === 'linkify'
        ? trimAutoUrl(label)
        : token.attrGet('href') || ''
    if (token.markup === 'linkify') label = href
    const resource = displayResource(href, label, source)
    if (resource) out.push(resource)
  }
  return out
}

export function markdownResources(
  text: string,
  sourceMessageId: string,
): DisplayResource[] {
  return markdown
    .parse(text, {})
    .flatMap((token) =>
      token.type === 'inline' && token.children
        ? inlineResources(token.children, sourceMessageId)
        : [],
    )
}

export function standaloneResource(
  text: string,
  sourceMessageId: string,
): DisplayResource | null {
  const tokens = markdown.parse(text.trim(), {})
  if (
    tokens.length !== 3 ||
    tokens[0]?.type !== 'paragraph_open' ||
    tokens[1]?.type !== 'inline'
  )
    return null
  const children =
    tokens[1].children?.filter((t) => t.type !== 'text' || t.content.trim()) ??
    []
  if (
    children[0]?.type !== 'link_open' ||
    children.at(-1)?.type !== 'link_close' ||
    children.filter((t) => t.type === 'link_open').length !== 1
  )
    return null
  return inlineResources(children, sourceMessageId)[0] ?? null
}

export type ResourceMarkdownSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'resource'; resource: DisplayResource }
export function resourceMarkdownSegments(
  text: string,
  sourceMessageId: string,
): ResourceMarkdownSegment[] {
  const lines = text.split('\n')
  const segments: ResourceMarkdownSegment[] = []
  let last = 0
  const env: {
    references?: Record<string, { href: string; title?: string }>
  } = {}
  const parsed = markdown.parse(text, env)
  // Each markdown segment renders on its own, so reference-style links
  // (`[x][1]` … `[1]: url`) need the definitions repeated in every segment.
  const definitions = Object.entries(env.references ?? {})
    .map(
      ([label, ref]) =>
        `[${label}]: <${ref.href}>` +
        (ref.title ? ` "${ref.title.replace(/"/g, '\\"')}"` : ''),
    )
    .join('\n')
  const withDefinitions = (segment: string): string =>
    definitions ? `${segment}\n\n${definitions}\n` : segment
  for (const token of parsed) {
    if (token.type !== 'paragraph_open' || token.level !== 0 || !token.map)
      continue
    const [from, to] = token.map
    const resource = standaloneResource(
      lines.slice(from, to).join('\n'),
      sourceMessageId,
    )
    if (!resource) continue
    if (from > last && lines.slice(last, from).join('\n').trim())
      segments.push({
        kind: 'markdown',
        text: withDefinitions(lines.slice(last, from).join('\n') + '\n'),
      })
    segments.push({ kind: 'resource', resource })
    last = to
  }
  if (!segments.length) return [{ kind: 'markdown', text }]
  if (last < lines.length && lines.slice(last).join('\n').trim())
    segments.push({
      kind: 'markdown',
      text: withDefinitions(lines.slice(last).join('\n')),
    })
  return segments
}

export interface ResourceUrlSpan {
  start: number
  end: number
  resource: DisplayResource
}
/** linkify-it includes CJK sentence punctuation in URL paths; explicit Markdown links are untouched. */
export function trimAutoUrl(text: string): string {
  return text.split(/[，。；！？、）】》]/u, 1)[0] ?? text
}
/** Text ranges for decorations. Original text and all UTF-16 offsets stay intact. */
export function resourceUrlSpans(
  text: string,
  sourceMessageId: string,
): ResourceUrlSpan[] {
  const codeRanges: Array<[number, number]> = []
  const lineOffsets = [0]
  for (const match of text.matchAll(/\n/g)) lineOffsets.push(match.index! + 1)
  // Markdown maps include unfinished fences, indented code and nested blocks.
  for (const token of markdown.parse(text, {})) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map)
      codeRanges.push([
        lineOffsets[token.map[0]] ?? text.length,
        lineOffsets[token.map[1]] ?? text.length,
      ])
  }
  const backticks = [...text.matchAll(/`+/g)]
  for (let i = 0; i < backticks.length; i++) {
    const opening = backticks[i]!
    if (
      codeRanges.some(
        ([from, to]) => opening.index! >= from && opening.index! < to,
      )
    )
      continue
    const close = backticks.findIndex(
      (run, j) => j > i && run[0].length === opening[0].length,
    )
    if (close >= 0) {
      const closing = backticks[close]!
      codeRanges.push([opening.index!, closing.index! + closing[0].length])
      i = close
    }
  }
  return (markdown.linkify.match(text) ?? []).flatMap((match) => {
    if (
      !/^https?:\/\//i.test(match.raw) ||
      codeRanges.some(([from, to]) => match.index >= from && match.index < to)
    )
      return []
    const raw = trimAutoUrl(match.raw)
    const resource = displayResource(raw, '', sourceMessageId)
    return resource
      ? [{ start: match.index, end: match.index + raw.length, resource }]
      : []
  })
}
