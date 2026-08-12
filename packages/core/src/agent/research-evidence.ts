import { createHash } from 'node:crypto'
import type { ToolCallRequest } from '../providers/base'
import type { ToolEvidenceDisposition, ToolResultObj } from '../tools/base'

export interface ResearchRequirement {
  readonly required: boolean
  readonly reason: 'none' | 'skill' | 'url' | 'explicit_request' | 'tool'
}

export interface ResearchSourceRecord {
  readonly id: string
  readonly url: string
  readonly aliases: string[]
  readonly disposition: Exclude<ToolEvidenceDisposition, 'none'>
  readonly transport: string
  readonly toolCallId: string
  readonly contentSha256: string
  readonly excerpt: string
}

export interface ResearchEvidenceSnapshot {
  readonly candidates: ResearchSourceRecord[]
  readonly verified: ResearchSourceRecord[]
}

export interface ResearchClaimUnit {
  readonly id: string
  readonly text: string
  readonly citedSourceIds: string[]
}

export interface ResearchValidationDecision {
  readonly passed: boolean
  readonly reasonCodes: string[]
  readonly units: ResearchClaimUnit[]
  readonly citedSourceIds: string[]
}

export interface GroundingReviewVerdict {
  readonly passed: boolean
  readonly unsupportedUnitIds: string[]
  readonly reasonCodes: string[]
}

const URL_PATTERN = /https?:\/\/[^\s<>()"']+/g
const MAX_SOURCES = 64
const MAX_EXCERPT_CHARS = 4_000
const MAX_FINAL_SOURCES = 12

/**
 * Turn-scoped source ledger. Tool metadata never gets to self-assert verified
 * evidence: only a successful Core web_fetch response can promote a URL.
 */
export class ResearchEvidenceLedger {
  private readonly records = new Map<string, ResearchSourceRecord>()
  private readonly redirectLinks = new Map<string, Set<string>>()
  private nextId = 1

  recordToolResult(
    call: ToolCallRequest,
    result: ToolResultObj,
    options: { readonly externalContent: boolean },
  ): void {
    if (!options.externalContent) return
    const outcome = String(
      result.metadata.outcome ?? (result.isError ? 'failure' : 'success'),
    )
    if (call.name === 'web_fetch' && outcome === 'followup_required') {
      const original = safeEvidenceUrl(result.metadata.original_url)
      const redirect = safeEvidenceUrl(result.metadata.redirect_url)
      if (original && redirect) {
        this.linkRedirect(original, redirect)
        const content = result.rawContent || result.modelContent
        this.upsert(original, {
          disposition: 'candidate',
          transport: 'web_fetch_redirect',
          toolCallId: call.id,
          content,
        })
        this.upsert(redirect, {
          disposition: 'candidate',
          transport: 'web_fetch_redirect',
          toolCallId: call.id,
          content,
        })
      }
      return
    }
    if (result.isError || outcome !== 'success') return

    if (call.name === 'web_fetch' && successfulWebFetch(result)) {
      const url = safeEvidenceUrl(result.metadata.url)
      if (!url) return
      this.upsert(url, {
        disposition: 'verified',
        transport: 'web_fetch',
        toolCallId: call.id,
        content: result.rawContent || result.modelContent,
      })
      return
    }

    for (const url of candidateUrls(result)) {
      this.upsert(url, {
        disposition: 'candidate',
        transport: call.name,
        toolCallId: call.id,
        content: result.rawContent || result.modelContent,
      })
    }
  }

  snapshot(): ResearchEvidenceSnapshot {
    const values = [...this.records.values()].map(cloneSource)
    return {
      candidates: values.filter((item) => item.disposition === 'candidate'),
      verified: values.filter((item) => item.disposition === 'verified'),
    }
  }

  private upsert(
    url: string,
    input: {
      disposition: 'candidate' | 'verified'
      transport: string
      toolCallId: string
      content: string
    },
  ): void {
    const canonical = canonicalEvidenceUrl(url)
    if (!canonical) return
    if (input.disposition === 'verified') {
      const aliases = this.connectedRedirectAliases(canonical)
      aliases.add(canonical)
      const previous = [...aliases]
        .map((alias) => this.records.get(alias))
        .filter((record): record is ResearchSourceRecord => Boolean(record))
        .sort(
          (left, right) => sourceSequence(left.id) - sourceSequence(right.id),
        )
      for (const alias of aliases) this.records.delete(alias)
      const id = previous[0]?.id ?? `source_${this.nextId++}`
      this.records.set(canonical, {
        id,
        url: canonical,
        aliases: [...aliases].sort(),
        disposition: 'verified',
        transport: input.transport,
        toolCallId: input.toolCallId,
        contentSha256: sha256(input.content),
        excerpt: boundedExcerpt(input.content),
      })
      return
    }
    const existing = this.records.get(canonical)
    if (existing) {
      return
    }
    if (this.records.size >= MAX_SOURCES) return
    this.records.set(canonical, {
      id: `source_${this.nextId++}`,
      url: canonical,
      aliases: [canonical],
      disposition: input.disposition,
      transport: input.transport,
      toolCallId: input.toolCallId,
      contentSha256: sha256(input.content),
      excerpt: boundedExcerpt(input.content),
    })
  }

  private linkRedirect(left: string, right: string): void {
    const leftKey = canonicalEvidenceUrl(left)
    const rightKey = canonicalEvidenceUrl(right)
    if (!leftKey || !rightKey) return
    const leftLinks = this.redirectLinks.get(leftKey) ?? new Set<string>()
    leftLinks.add(rightKey)
    this.redirectLinks.set(leftKey, leftLinks)
    const rightLinks = this.redirectLinks.get(rightKey) ?? new Set<string>()
    rightLinks.add(leftKey)
    this.redirectLinks.set(rightKey, rightLinks)
  }

  private connectedRedirectAliases(url: string): Set<string> {
    const found = new Set<string>()
    const queue = [url]
    while (queue.length) {
      const current = queue.shift()!
      if (found.has(current)) continue
      found.add(current)
      for (const next of this.redirectLinks.get(current) ?? [])
        if (!found.has(next)) queue.push(next)
    }
    return found
  }
}

export function assessResearchRequirement(
  task: string | null | undefined,
  skillRequiresEvidence: boolean,
): ResearchRequirement {
  if (skillRequiresEvidence) return { required: true, reason: 'skill' }
  const text = String(task ?? '').trim()
  if (!text) return { required: false, reason: 'none' }
  if (URL_PATTERN.test(text)) {
    URL_PATTERN.lastIndex = 0
    return { required: true, reason: 'url' }
  }
  URL_PATTERN.lastIndex = 0
  const localOnly =
    /(?:本项目|当前项目|代码库|workspace|repository|repo|local\s+(?:code|file))/i.test(
      text,
    ) &&
    !/(?:互联网|全网|网上|网络|今日|今天|最新|新闻|热点|web|internet|online)/i.test(
      text,
    )
  if (localOnly) return { required: false, reason: 'none' }
  const explicit =
    /(?:互联网|全网|网上|网络|今日|今天|最新|新闻|热点|时事|research\s+(?:online|the\s+web)|search\s+(?:online|the\s+web|the\s+internet)|look\s+up|latest\b|today(?:'s)?\b|current\s+(?:events|news)|news\b)/i.test(
      text,
    )
  return explicit
    ? { required: true, reason: 'explicit_request' }
    : { required: false, reason: 'none' }
}

export function validateResearchReply(
  reply: string,
  sources: readonly ResearchSourceRecord[],
): ResearchValidationDecision {
  const verified = sources.filter((source) => source.disposition === 'verified')
  const byUrl = new Map<string, ResearchSourceRecord>()
  for (const source of verified) {
    for (const alias of [source.url, ...source.aliases]) {
      const canonical = canonicalEvidenceUrl(alias)
      if (canonical) byUrl.set(canonical, source)
    }
  }

  const reasons = new Set<string>()
  if (!verified.length) reasons.add('no_verified_sources')
  for (const candidate of reply.match(URL_PATTERN) ?? []) {
    const canonical = canonicalEvidenceUrl(candidate)
    if (!canonical) reasons.add('invalid_citation_url')
    else if (!byUrl.has(canonical)) reasons.add('unverified_url')
  }

  const units: ResearchClaimUnit[] = []
  const cited = new Set<string>()
  for (const text of factualUnits(reply)) {
    const sourceIds: string[] = []
    for (const url of markdownLinkUrls(text)) {
      const canonical = canonicalEvidenceUrl(url)
      const source = canonical ? byUrl.get(canonical) : undefined
      if (!source) continue
      if (!sourceIds.includes(source.id)) sourceIds.push(source.id)
      cited.add(source.id)
    }
    const unit = {
      id: `unit_${units.length + 1}`,
      text,
      citedSourceIds: sourceIds,
    }
    units.push(unit)
    if (!sourceIds.length) reasons.add('uncited_claim_unit')
  }
  if (!units.length) reasons.add('no_claim_units')
  if (cited.size > MAX_FINAL_SOURCES) reasons.add('too_many_sources')
  return {
    passed: reasons.size === 0,
    reasonCodes: [...reasons],
    units,
    citedSourceIds: [...cited],
  }
}

export function parseGroundingReviewVerdict(
  text: string | null | undefined,
): GroundingReviewVerdict | null {
  let value: unknown
  try {
    value = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.passed !== 'boolean' ||
    !Array.isArray(record.unsupported_unit_ids) ||
    !Array.isArray(record.reason_codes) ||
    record.unsupported_unit_ids.some((item) => typeof item !== 'string') ||
    record.reason_codes.some((item) => typeof item !== 'string')
  )
    return null
  return {
    passed: record.passed,
    unsupportedUnitIds: uniqueBoundedStrings(record.unsupported_unit_ids, 64),
    reasonCodes: uniqueBoundedStrings(record.reason_codes, 64),
  }
}

function successfulWebFetch(result: ToolResultObj): boolean {
  const status = Number(result.metadata.http_status ?? result.metadata.status)
  return (
    result.metadata.success_scope === 'response_body' &&
    Number.isInteger(status) &&
    status >= 200 &&
    status < 300
  )
}

function candidateUrls(result: ToolResultObj): string[] {
  const evidence =
    result.metadata.evidence &&
    typeof result.metadata.evidence === 'object' &&
    !Array.isArray(result.metadata.evidence)
      ? (result.metadata.evidence as Record<string, unknown>)
      : {}
  const external =
    result.metadata.external_content &&
    typeof result.metadata.external_content === 'object' &&
    !Array.isArray(result.metadata.external_content)
      ? (result.metadata.external_content as Record<string, unknown>)
      : {}
  const source =
    external.source &&
    typeof external.source === 'object' &&
    !Array.isArray(external.source)
      ? (external.source as Record<string, unknown>)
      : {}
  const rows = Array.isArray(result.metadata.results)
    ? (result.metadata.results as Array<Record<string, unknown>>)
    : []
  const candidates = [
    result.metadata.url,
    evidence.url,
    ...(Array.isArray(evidence.urls) ? evidence.urls : []),
    source.locator,
    ...rows.map((row) => row?.url),
    ...(result.rawContent.match(URL_PATTERN) ?? []),
  ]
  const urls = new Set<string>()
  for (const candidate of candidates) {
    const url = safeEvidenceUrl(candidate)
    if (url) urls.add(url)
  }
  return [...urls]
}

function safeEvidenceUrl(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text || text.includes('...')) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password) return null
    if (
      !url.hostname ||
      !url.hostname.includes('.') ||
      url.hostname.includes('..')
    )
      return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function canonicalEvidenceUrl(value: unknown): string | null {
  return safeEvidenceUrl(value)
}

function factualUnits(reply: string): string[] {
  const units: string[] = []
  let paragraph: string[] = []
  let fenced = false
  let sourcesSection = false
  const flush = () => {
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (isFactualUnit(text)) units.push(text)
  }
  for (const rawLine of String(reply ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('```')) {
      flush()
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (/^(?:#{1,6}\s*)?(?:sources?|来源|参考资料)\s*[:：]?$/i.test(line)) {
      flush()
      sourcesSection = true
      continue
    }
    if (sourcesSection) continue
    if (!line) {
      flush()
      continue
    }
    if (/^\|?\s*:?-{3,}/.test(line)) continue
    if (
      /^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/.test(line) ||
      line.startsWith('|')
    ) {
      flush()
      const text = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, '').trim()
      if (isFactualUnit(text)) units.push(text)
      continue
    }
    paragraph.push(line)
  }
  flush()
  return units
}

function isFactualUnit(text: string): boolean {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return false
  if (plain.length <= 40 && /[:：]$/.test(plain)) return false
  return plain.length >= 8
}

function markdownLinkUrls(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map(
    (match) => match[1]!,
  )
}

function cloneSource(source: ResearchSourceRecord): ResearchSourceRecord {
  return { ...source, aliases: [...source.aliases] }
}

function boundedExcerpt(value: string): string {
  return String(value ?? '')
    .trim()
    .slice(0, MAX_EXCERPT_CHARS)
}

function sha256(value: string): string {
  return createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
}

function uniqueBoundedStrings(values: unknown[], max: number): string[] {
  return [
    ...new Set(
      values.map((value) => String(value).trim().slice(0, 160)).filter(Boolean),
    ),
  ].slice(0, max)
}

function sourceSequence(id: string): number {
  const value = Number(String(id).replace(/^source_/, ''))
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}
