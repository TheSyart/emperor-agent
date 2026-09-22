/**
 * Settings › Skills view model: pure helpers for the list (source filter,
 * search, ordering), the invalid-Skill notice, the detail facts, read-only
 * rules, SKILL.md frontmatter name detection and `skills.import` result
 * mapping. No Vue, no IO — unit-tested in skillsModel.test.ts.
 */
import type {
  SkillErrorInfo,
  SkillImportResult,
  SkillScope,
} from '../../../api/skills'
import { isDraftSessionId } from '../../../runtime/sessionDrafts'
import type { InvalidSkillInfo, SessionInfo, SkillInfo } from '../../../types'
import type { DefinitionItem, SegmentedOption, SelectOption } from '../ui'

export type SkillSourceKey = 'user' | 'project' | 'plugin' | 'builtin'
export type SkillSourceFilter = 'all' | SkillSourceKey
export type SkillBadgeTone = 'ok' | 'warn' | 'error' | 'neutral' | 'accent'

/** Display order of sources (also the Segmented filter order). */
export const SKILL_SOURCE_ORDER: readonly SkillSourceKey[] = [
  'user',
  'project',
  'plugin',
  'builtin',
]

export const SKILL_SOURCE_LABELS: Record<SkillSourceKey, string> = {
  user: '个人',
  project: '项目',
  plugin: '插件',
  builtin: '内置',
}

export const SKILL_SOURCE_FILTERS: readonly SegmentedOption<SkillSourceFilter>[] =
  [
    { value: 'all', label: '全部' },
    ...SKILL_SOURCE_ORDER.map((value) => ({
      value,
      label: SKILL_SOURCE_LABELS[value],
    })),
  ]

/** Where Skills of a writable scope live (hint text; Core owns the paths). */
export const SKILL_SCOPE_HINTS: Record<SkillScope, string> = {
  user: '~/.emperor/skills',
  project: '<项目>/.emperor/skills',
}

/** Placeholder / starter SKILL.md for the paste dialog. */
export const SKILL_TEMPLATE = `---
name: my-skill
description: 一句话说明什么时候使用这个 Skill。
---

# My Skill

## 何时使用

- …

## 步骤

1. …
`

/** Normalized source of a Skill or invalid Skill (`verified_plugin` → plugin). */
export function skillSource(item: { source?: string | null }): SkillSourceKey {
  const source = String(item.source ?? '')
  if (source === 'project' || source === 'user' || source === 'builtin')
    return source
  if (source === 'plugin' || source === 'verified_plugin') return 'plugin'
  return 'user'
}

export function skillSourceLabel(item: { source?: string | null }): string {
  return SKILL_SOURCE_LABELS[skillSource(item)]
}

/** The current project's Skills stand out; every other source is neutral. */
export function skillSourceTone(item: {
  source?: string | null
}): SkillBadgeTone {
  return skillSource(item) === 'project' ? 'accent' : 'neutral'
}

// ── read-only rules ────────────────────────────────────────────────────────

/** Builtin and Plugin Skills are read-only (Core `readOnly`, else by source). */
export function isSkillReadOnly(skill: {
  readOnly?: boolean
  source?: string | null
}): boolean {
  if (typeof skill.readOnly === 'boolean') return skill.readOnly
  const source = skillSource(skill)
  return source === 'builtin' || source === 'plugin'
}

export function canSaveSkill(skill: {
  readOnly?: boolean
  source?: string | null
}): boolean {
  return !isSkillReadOnly(skill)
}

export function canDeleteSkill(skill: {
  readOnly?: boolean
  source?: string | null
}): boolean {
  return !isSkillReadOnly(skill)
}

/** 「复制为个人 Skill」 is offered exactly where editing is not. */
export function canCopySkillToUser(skill: {
  readOnly?: boolean
  source?: string | null
}): boolean {
  return isSkillReadOnly(skill)
}

// ── list ───────────────────────────────────────────────────────────────────

export interface SkillFilter {
  query?: string
  source?: SkillSourceFilter
}

function queryTerms(query: string | undefined): string[] {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function matchesTerms(haystack: string, terms: string[]): boolean {
  const text = haystack.toLowerCase()
  return terms.every((term) => text.includes(term))
}

function sourceRank(item: { source?: string | null }): number {
  return SKILL_SOURCE_ORDER.indexOf(skillSource(item))
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name)
}

/** Skills matching the source filter and every search term, source-then-name ordered. */
export function filterSkills(
  skills: readonly SkillInfo[],
  filter: SkillFilter = {},
): SkillInfo[] {
  const source = filter.source ?? 'all'
  const terms = queryTerms(filter.query)
  return skills
    .filter((skill) => source === 'all' || skillSource(skill) === source)
    .filter(
      (skill) =>
        !terms.length ||
        matchesTerms(
          [skill.name, skill.description, skill.tags, skill.path]
            .filter(Boolean)
            .join(' '),
          terms,
        ),
    )
    .sort((a, b) => sourceRank(a) - sourceRank(b) || byName(a, b))
}

/** The invalid-Skill notice follows the same source filter and search. */
export function filterInvalidSkills(
  invalid: readonly InvalidSkillInfo[],
  filter: SkillFilter = {},
): InvalidSkillInfo[] {
  const source = filter.source ?? 'all'
  const terms = queryTerms(filter.query)
  return invalid
    .filter((item) => source === 'all' || skillSource(item) === source)
    .filter(
      (item) =>
        !terms.length ||
        matchesTerms(`${item.name} ${item.reason} ${item.path}`, terms),
    )
    .sort((a, b) => sourceRank(a) - sourceRank(b) || byName(a, b))
}

/** Valid Skills per source filter value (`all` included). */
export function skillSourceCounts(
  skills: readonly SkillInfo[],
): Record<SkillSourceFilter, number> {
  const counts: Record<SkillSourceFilter, number> = {
    all: skills.length,
    user: 0,
    project: 0,
    plugin: 0,
    builtin: 0,
  }
  for (const skill of skills) counts[skillSource(skill)] += 1
  return counts
}

/** Trailing count of the search box: 「12 个」 or 「3 / 12」 while filtered. */
export function skillCountText(visible: number, total: number): string {
  if (!total) return ''
  return visible === total ? `${total} 个` : `${visible} / ${total}`
}

// ── detail ─────────────────────────────────────────────────────────────────

function splitTags(tags: string | undefined): string[] {
  return String(tags ?? '')
    .split(/[,;，、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/** 「命令 git、node · 运行时 python · 环境变量 TOKEN」 or '' when none. */
export function skillRequirementsText(
  requirements: SkillInfo['requirements'] | undefined,
): string {
  if (!requirements) return ''
  const parts: string[] = []
  if (requirements.bins?.length)
    parts.push(`命令 ${requirements.bins.join('、')}`)
  if (requirements.runtimes?.length)
    parts.push(`运行时 ${requirements.runtimes.join('、')}`)
  if (requirements.env?.length)
    parts.push(`环境变量 ${requirements.env.join('、')}`)
  return parts.join(' · ')
}

/** DefinitionList facts of the Skill detail. */
export function skillFacts(skill: SkillInfo): DefinitionItem[] {
  const items: DefinitionItem[] = [
    { key: 'source', term: '来源', value: skillSourceLabel(skill) },
    {
      key: 'file',
      term: '文件',
      value: skill.skillFile || skill.path,
      mono: true,
    },
    { key: 'tags', term: '标签', value: splitTags(skill.tags).join('、') },
    {
      key: 'requirements',
      term: '依赖',
      value: skillRequirementsText(skill.requirements),
    },
  ]
  if (skill.always)
    items.push({ key: 'always', term: '加载', value: '始终注入上下文' })
  return items
}

/** Folder to reveal for a Skill: its root, else the folder of its file. */
export function skillFolder(skill: {
  root?: string
  skillFile?: string
  path: string
}): string {
  if (skill.root) return skill.root
  return parentPath(skill.skillFile || skill.path)
}

// ── invalid Skills ─────────────────────────────────────────────────────────

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

export function basenameOf(path: string): string {
  const trimmed = trimTrailingSeparators(String(path ?? ''))
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function parentPath(path: string): string {
  const trimmed = trimTrailingSeparators(String(path ?? ''))
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index < 0) return trimmed
  return index === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, index)
}

/**
 * `skills.delete` arguments for an invalid Skill: its folder (or `.md` file)
 * name plus the scope it was found in. Only personal and project Skills can
 * be deleted (null otherwise).
 */
export function invalidSkillDeleteTarget(
  item: InvalidSkillInfo,
): { name: string; scope: SkillScope } | null {
  const source = skillSource(item)
  if (source !== 'user' && source !== 'project') return null
  const name = basenameOf(item.path)
  return name ? { name, scope: source } : null
}

/** Folder to reveal for an invalid Skill (the parent of a single `.md` file). */
export function invalidSkillFolder(item: InvalidSkillInfo): string {
  return /\.md$/i.test(item.path) ? parentPath(item.path) : item.path
}

// ── sessions / scopes ──────────────────────────────────────────────────────

/** Session id that scopes `skills.*` (drafts have no project on disk yet). */
export function skillSessionId(id: string | null | undefined): string | null {
  const value = String(id ?? '').trim()
  return value && !isDraftSessionId(value) ? value : null
}

export interface SkillProject {
  name: string
  path: string
}

/** The project of a persisted Build session, else null (project scope unavailable). */
export function skillProject(
  session:
    | Pick<SessionInfo, 'mode' | 'draft' | 'project_path' | 'project_name'>
    | null
    | undefined,
): SkillProject | null {
  if (!session || session.draft || session.mode !== 'build') return null
  const path = String(session.project_path ?? '').trim()
  if (!path) return null
  const name = String(session.project_name ?? '').trim() || basenameOf(path)
  return { name, path }
}

/** 「保存到」 options: 个人 always, 当前项目 while a Build session is active. */
export function skillScopeOptions(
  project: SkillProject | null,
): SelectOption<SkillScope>[] {
  const options: SelectOption<SkillScope>[] = [
    { value: 'user', label: '个人', description: SKILL_SCOPE_HINTS.user },
  ]
  if (project)
    options.push({
      value: 'project',
      label: `当前项目 · ${project.name}`,
      description: `${project.path}/.emperor/skills`,
    })
  return options
}

// ── SKILL.md frontmatter ───────────────────────────────────────────────────

interface FrontmatterBlock {
  lines: string[]
  /** Index of the opening `---` line. */
  start: number
  /** Index of the closing `---` / `...` line. */
  end: number
}

function frontmatterBlock(content: string): FrontmatterBlock | null {
  const lines = String(content ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (line === '---' || line === '...') return { lines, start: 0, end: index }
  }
  return null
}

const NAME_LINE = /^name\s*:(.*)$/

function scalarValue(raw: string): string {
  let value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  )
    return value.slice(1, -1).trim()
  // Plain scalars end at an inline comment (` #`).
  const comment = value.search(/\s#/)
  if (comment >= 0) value = value.slice(0, comment)
  return value.trim()
}

/**
 * The top-level `name` of the SKILL.md frontmatter (last one wins, like the
 * lenient Core parser), or null when there is no frontmatter / no name.
 */
export function detectFrontmatterName(content: string): string | null {
  const block = frontmatterBlock(content)
  if (!block) return null
  let name: string | null = null
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = NAME_LINE.exec(block.lines[index] ?? '')
    if (match) name = scalarValue(match[1] ?? '') || null
  }
  return name
}

/**
 * SKILL.md with its frontmatter `name` set to `name` (what `skills.import`
 * writes for a renamed paste), so validation previews the imported file.
 * Content without frontmatter is returned unchanged.
 */
export function withFrontmatterName(content: string, name: string): string {
  const block = frontmatterBlock(content)
  const next = name.trim()
  if (!block || !next) return content
  const lines = [...block.lines]
  let replaced = false
  for (let index = block.end - 1; index > block.start; index -= 1) {
    if (NAME_LINE.test(lines[index] ?? '')) {
      lines[index] = `name: ${next}`
      replaced = true
      break
    }
  }
  if (!replaced) lines.splice(block.start + 1, 0, `name: ${next}`)
  return lines.join('\n')
}

// ── import results ─────────────────────────────────────────────────────────

export interface SkillImportedRow {
  name: string
  scope: SkillScope
  scopeLabel: string
  path: string
  warnings: string[]
  replaced: boolean
}

export interface SkillImportFailureRow {
  name: string | null
  path: string
  reason: string
  /** A same-named Skill exists; importing again with overwrite replaces it. */
  conflict: boolean
}

export interface SkillImportSummary {
  imported: SkillImportedRow[]
  failures: SkillImportFailureRow[]
  /** Names that failed only because they already exist. */
  conflicts: string[]
  tone: SkillBadgeTone
  headline: string
}

function scopeLabel(scope: SkillScope): string {
  return scope === 'project' ? '项目' : '个人'
}

/** Map `skills.import` output onto the dialog summary. */
export function summarizeSkillImport(
  result: SkillImportResult,
): SkillImportSummary {
  const imported = result.imported.map((entry) => ({
    name: entry.name,
    scope: entry.scope,
    scopeLabel: scopeLabel(entry.scope),
    path: entry.path,
    warnings: [...entry.warnings],
    replaced: entry.replaced,
  }))
  const failures = result.errors.map((entry) => ({
    name: entry.name,
    path: entry.path,
    reason: entry.reason,
    conflict: entry.code === 'skill_exists' && Boolean(entry.name),
  }))
  const conflicts = [
    ...new Set(
      failures
        .filter((entry) => entry.conflict && entry.name)
        .map((entry) => entry.name as string),
    ),
  ]
  const warned = imported.some((entry) => entry.warnings.length)
  const tone: SkillBadgeTone = !imported.length
    ? 'error'
    : failures.length || warned
      ? 'warn'
      : 'ok'
  return { imported, failures, conflicts, tone, headline: headline() }

  function headline(): string {
    if (!imported.length && !failures.length) return '没有导入任何 Skill'
    if (!imported.length)
      return conflicts.length === failures.length
        ? `已存在同名 Skill：${conflicts.join('、')}`
        : `导入失败（${failures.length} 个）`
    const done =
      imported.length === 1
        ? `已导入 Skill「${imported[0]!.name}」`
        : `已导入 ${imported.length} 个 Skill`
    return failures.length ? `${done}，${failures.length} 个失败` : done
  }
}

/** A thrown `skills.import` failure as a summary (the whole import failed). */
export function skillImportErrorSummary(
  error: SkillErrorInfo,
  name: string | null = null,
): SkillImportSummary {
  const conflict = error.code === 'skill_exists'
  return {
    imported: [],
    failures: [{ name, path: '.', reason: error.message, conflict }],
    conflicts: conflict && name ? [name] : [],
    tone: 'error',
    headline: conflict && name ? `已存在同名 Skill：${name}` : '导入失败',
  }
}

/** Toast text after an import that needs no further attention. */
export function skillImportToast(summary: SkillImportSummary): string {
  const replaced = summary.imported.filter((entry) => entry.replaced).length
  return replaced
    ? `${summary.headline}（覆盖 ${replaced} 个）`
    : summary.headline
}

// ── validation ─────────────────────────────────────────────────────────────

export interface SkillValidationBadge {
  tone: SkillBadgeTone
  label: string
}

/** Header badge of a live validation (null before anything was checked). */
export function skillValidationBadge(state: {
  pending: boolean
  failure?: string
  result: { valid: boolean; errors: string[]; warnings: string[] } | null
}): SkillValidationBadge | null {
  if (state.pending) return { tone: 'neutral', label: '校验中…' }
  if (state.failure) return { tone: 'error', label: '无法校验' }
  const result = state.result
  if (!result) return null
  if (!result.valid || result.errors.length)
    return {
      tone: 'error',
      label: `${Math.max(result.errors.length, 1)} 个错误`,
    }
  if (result.warnings.length)
    return { tone: 'warn', label: `${result.warnings.length} 条提示` }
  return { tone: 'ok', label: '校验通过' }
}

/** Unique, non-empty messages in first-seen order. */
export function uniqueMessages(
  ...lists: readonly (readonly string[])[]
): string[] {
  const seen = new Set<string>()
  for (const list of lists)
    for (const message of list) {
      const text = String(message ?? '').trim()
      if (text) seen.add(text)
    }
  return [...seen]
}

// ── URL import ─────────────────────────────────────────────────────────────

/** Local check of the URL field; '' when it can be sent to Core. */
export function skillUrlError(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return '请输入完整的链接，例如 https://github.com/owner/repo'
  }
  if (url.protocol !== 'https:') return '只支持 https 链接'
  return ''
}
