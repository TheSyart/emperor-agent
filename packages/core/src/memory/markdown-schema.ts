export type MemoryMarkdownKind =
  'user_profile' | 'global' | 'project' | 'episode'

const CANONICAL_SECTIONS: Record<MemoryMarkdownKind, string[]> = {
  user_profile: [
    '基本信息',
    '偏好设置',
    '沟通风格',
    '回复长度',
    '技术水平',
    '工作背景',
    '兴趣领域',
    '性格与工作风格',
    '角色互动偏好',
    'Stable Preferences',
    'Working Style',
    'Long-Term Constraints',
    'Deprecated',
  ],
  global: [
    'Long-Term Projects',
    'Cross-Project Decisions',
    'Open Questions',
    'Deprecated',
  ],
  project: [
    'Project Identity',
    'Architecture Notes',
    'Build Commands',
    'Design Decisions',
    'Open Tasks',
    'Known Issues',
    'Deprecated',
  ],
  episode: ['Summary', 'Decisions', 'Follow-ups', 'Raw References'],
}

export function canonicalSections(kind: MemoryMarkdownKind): string[] {
  return [...CANONICAL_SECTIONS[kind]]
}

export function sectionBody(markdown: string, section: string): string {
  const lines = splitLines(markdown)
  const range = findSectionRange(lines, section)
  if (!range) return ''
  return lines
    .slice(range.bodyStart, range.bodyEnd)
    .join('\n')
    .replace(/\s+$/, '')
}

export function appendSectionItem(
  markdown: string,
  section: string,
  item: string,
): string {
  const existing = sectionBody(markdown, section)
  const nextBody = existing
    ? `${existing}\n${String(item).trimEnd()}`
    : String(item).trimEnd()
  return replaceSection(markdown, section, nextBody)
}

export function replaceSection(
  markdown: string,
  section: string,
  content: string,
): string {
  const lines = splitLines(markdown)
  const normalizedContent = String(content ?? '').trimEnd()
  const contentLines = normalizedContent ? normalizedContent.split('\n') : []
  const range = findSectionRange(lines, section)
  if (!range) {
    const prefix = markdown.trimEnd()
    const addition = [`## ${section}`, ...contentLines].join('\n')
    return `${prefix}${prefix ? '\n\n' : ''}${addition}\n`
  }
  const next = [
    ...lines.slice(0, range.bodyStart),
    ...contentLines,
    ...lines.slice(range.bodyEnd),
  ]
  return `${next.join('\n').replace(/\s+$/, '')}\n`
}

function splitLines(markdown: string): string[] {
  return String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
}

function findSectionRange(
  lines: string[],
  section: string,
): { heading: number; bodyStart: number; bodyEnd: number } | null {
  const target = normalizeHeading(section)
  const heading = lines.findIndex(
    (line) => normalizeHeading(sectionHeading(line)) === target,
  )
  if (heading < 0) return null
  let bodyEnd = lines.length
  for (let index = heading + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/.test(lines[index] ?? '')) {
      bodyEnd = index
      break
    }
  }
  return { heading, bodyStart: heading + 1, bodyEnd }
}

function sectionHeading(line: string): string {
  const match = /^##\s+(.+?)\s*$/.exec(line)
  return match ? match[1]! : ''
}

function normalizeHeading(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}
