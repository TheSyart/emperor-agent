import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ContactTemplateError } from './errors'
import {
  AVATAR_SHEET_THEMES,
  AVATAR_THEMES,
  CONTACT_LIMITS,
  DOMAINS,
  LIBRARY_AVATAR_ID,
  MODEL_HINTS,
  SPEAK_MODES,
  TOOL_PRESETS,
  type ContactTemplate,
  type Domain,
} from './types'
import { charCount } from './validate'

/**
 * The 18 role templates (D15) in picker order: 软件工程、设计、内容、产品与决策.
 * Each is `templates/contacts/<id>.md`, shipped with the app's templates.
 */
export const CONTACT_TEMPLATE_IDS = [
  'architect',
  'code-reviewer',
  'test-engineer',
  'security-auditor',
  'frontend-engineer',
  'release-engineer',
  'asset-designer',
  'ui-reviewer',
  'researcher',
  'writer',
  'editor',
  'translator',
  'copywriter',
  'product-manager',
  'user-researcher',
  'data-analyst',
  'red-team',
  'moderator',
] as const

/** The five sections of a template body, in order, and the role field each fills. */
const SECTIONS = [
  ['职责', 'mission'],
  ['交付', 'deliverable'],
  ['工作方法', 'playbook'],
  ['边界', 'boundaries'],
  ['样例任务', 'trialTask'],
] as const

const MIN_PLAYBOOK_STEPS = 4

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One template file: YAML frontmatter (`name / intro / domains / tools /
 * permission / speak / modelHint / avatarTheme / avatar`) and the five `##`
 * sections. Throws {@link ContactTemplateError} naming what is missing.
 */
export function parseContactTemplate(
  id: string,
  source: string,
): ContactTemplate {
  const fail = (message: string): never => {
    throw new ContactTemplateError(id, message)
  }
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized)
  if (!match) return fail('缺少 frontmatter（--- … ---）')
  let data: unknown
  try {
    data = parseYaml(match[1]!)
  } catch (error) {
    return fail(`frontmatter 不是合法的 YAML：${(error as Error).message}`)
  }
  if (!isRecord(data)) return fail('frontmatter 不是键值表')

  const field = (key: string): string => {
    const value = data[key]
    if (typeof value !== 'string' || !value.trim())
      return fail(`frontmatter 缺少 ${key}`)
    return value.trim()
  }
  const choice = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = field(key)
    if (!(allowed as readonly string[]).includes(value))
      fail(`frontmatter ${key} 不对：${value}`)
    return value as T
  }

  const name = field('name')
  const intro = field('intro')
  if (charCount(intro) > CONTACT_LIMITS.intro || /\n/.test(intro))
    fail(`intro 要一行、最多 ${CONTACT_LIMITS.intro} 字`)
  const domains = data.domains
  if (
    !Array.isArray(domains) ||
    domains.length === 0 ||
    domains.length > CONTACT_LIMITS.domains ||
    domains.some((domain) => !(DOMAINS as readonly unknown[]).includes(domain))
  )
    fail('frontmatter domains 要 1–3 个合法领域')
  const tools = choice('tools', TOOL_PRESETS)
  const permission = choice('permission', [
    'read_only',
    'workspace_write',
  ] as const)
  const speak = choice('speak', SPEAK_MODES)
  const modelHint = choice('modelHint', MODEL_HINTS)
  const avatarTheme = choice('avatarTheme', AVATAR_THEMES)
  const avatar = field('avatar')
  if (!LIBRARY_AVATAR_ID.test(avatar))
    fail(`frontmatter avatar 不对：${avatar}`)
  if (AVATAR_SHEET_THEMES[avatar.slice(0, 5)] !== avatarTheme)
    fail(`头像 ${avatar} 不属于主题 ${avatarTheme}`)

  const body = match[2]!
  const headings = [...body.matchAll(/^## (.+)$/gm)]
  const titles = headings.map((heading) => heading[1]!.trim())
  const expected = SECTIONS.map(([title]) => title)
  for (const title of titles)
    if (!(expected as readonly string[]).includes(title))
      fail(`多出一节「${title}」`)
  for (const title of expected)
    if (!titles.includes(title)) fail(`缺少「${title}」一节`)
  if (titles.join('/') !== expected.join('/'))
    fail(`各节的顺序要是 ${expected.join('、')}`)

  const sections: Record<string, string> = {}
  headings.forEach((heading, index) => {
    const start = heading.index! + heading[0].length
    const end = headings[index + 1]?.index ?? body.length
    sections[heading[1]!.trim()] = body.slice(start, end).trim()
  })
  const role: ContactTemplate['role'] = {
    mission: '',
    deliverable: '',
    playbook: '',
    boundaries: '',
    knowledge: [],
  }
  for (const [title, key] of SECTIONS) {
    const text = sections[title] ?? ''
    if (!text) fail(`「${title}」一节是空的`)
    if (charCount(text) > CONTACT_LIMITS[key])
      fail(`「${title}」一节超过 ${CONTACT_LIMITS[key]} 字`)
    role[key] = text
  }
  const steps = role.playbook.match(/^\d+\. /gm) ?? []
  if (steps.length < MIN_PLAYBOOK_STEPS)
    fail(`「工作方法」至少要有 ${MIN_PLAYBOOK_STEPS} 个编号步骤`)

  return {
    id,
    name,
    intro,
    domains: domains as Domain[],
    tools,
    permission,
    speak,
    modelHint,
    avatarTheme,
    avatar,
    role,
  }
}

export interface ContactTemplateLoad {
  templates: ContactTemplate[]
  /** Files that are missing or broken (tests require none). */
  errors: string[]
}

/** Every template of `<templatesDir>/contacts/`, in picker order. */
export function loadContactTemplates(
  templatesDir: string,
): ContactTemplateLoad {
  const templates: ContactTemplate[] = []
  const errors: string[] = []
  for (const id of CONTACT_TEMPLATE_IDS) {
    const path = join(templatesDir, 'contacts', `${id}.md`)
    if (!existsSync(path)) {
      errors.push(`岗位模板 ${id}：文件不存在`)
      continue
    }
    try {
      templates.push(parseContactTemplate(id, readFileSync(path, 'utf8')))
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  return { templates, errors }
}
