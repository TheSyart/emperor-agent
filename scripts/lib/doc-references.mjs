// What the public documentation refers to must exist, used by
// check_public_docs.mjs (REL-06):
// - every 「设置 › … › …」 path names a real settings section and, after it,
//   names that really appear in that section's components;
// - every Core operation named in a code span is in CORE_OPERATION_REGISTRY;
// - no link or path points into the private, git-ignored private-docs/;
// - every page with a status header was verified on or after the day its
//   text last changed, and the commit it was checked against exists.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SETTINGS_DIR = 'desktop/src/renderer/src/components/settings'
const OPERATIONS_FILE = 'packages/core/src/api/operations.ts'

// ---------------------------------------------------------------------------
// Settings paths

/**
 * The settings modal as the docs may name it: each section's label (from
 * SETTINGS_SECTIONS) with every name that appears in its components — group,
 * row, sub page, tab and option titles. A section's components are its body
 * (SettingsModal.vue SECTION_BODIES) and everything it imports from the
 * settings folder, except the shared ui/ kit.
 */
export function settingsNavigation(root) {
  const dir = join(root, SETTINGS_DIR)
  const sectionsSource = readFileSync(join(dir, 'settingsSections.ts'), 'utf8')
  const labels = new Map()
  const list = sectionsSource.match(
    /export const SETTINGS_SECTIONS = \[([\s\S]*?)\] as const/,
  )
  for (const match of (list?.[1] ?? '').matchAll(
    /\{\s*key:\s*'([\w-]+)',\s*label:\s*'([^']+)'\s*\}/g,
  ))
    labels.set(match[1], match[2])

  const modal = readFileSync(join(dir, 'SettingsModal.vue'), 'utf8')
  const sections = new Map()
  for (const match of modal.matchAll(
    /^\s*([\w-]+):\s*defineAsyncComponent\(\s*\(\)\s*=>\s*import\('\.\/([^']+)'\)/gm,
  )) {
    const label = labels.get(match[1])
    if (!label) continue
    const files = componentFiles(dir, join(dir, match[2]))
    const names = new Set()
    for (const file of files)
      for (const name of namesIn(readFileSync(file, 'utf8'))) names.add(name)
    sections.set(label, { key: match[1], files, names })
  }
  return { sections }
}

function componentFiles(dir, entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /(?:from\s+|import\(\s*)'(\.{1,2}\/[^']+)'/g,
    )) {
      const target = resolveModule(resolve(dirname(file), match[1]))
      if (!target) continue
      const inside = relative(dir, target).split(sep)
      if (inside[0] === '..' || inside[0] === 'ui') continue
      if (/\.test\.ts$/.test(target)) continue
      queue.push(target)
    }
  }
  return [...seen].sort()
}

function resolveModule(path) {
  for (const candidate of [
    path,
    `${path}.ts`,
    `${path}.vue`,
    join(path, 'index.ts'),
  ])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return null
}

/** Every visible-looking string of a component: attributes, text, literals. */
export function namesIn(source) {
  const names = new Set()
  const add = (raw) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text && text.length <= 80) names.add(text)
  }
  for (const match of source.matchAll(/\s[:@]?[\w-]+="([^"]*)"/g)) add(match[1])
  for (const match of source.matchAll(/>([^<>]+)</g))
    for (const part of match[1].split(/\{\{[\s\S]*?\}\}/)) add(part)
  for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) add(match[1])
  for (const match of source.matchAll(/`([^`$\\]*)`/g)) add(match[1])
  return names
}

// A path is 设置 followed by › segments. 系统设置 (macOS System Settings) and
// 偏好设置 (the app menu) are not ours.
const PATH =
  /(?<!系统)(?<!偏好)设置((?:\s*[›→]\s*[^›→」”"*`（）()，。；、：:\n|]+)+)/g

/** The settings paths in a Markdown text, with their line numbers. */
export function settingsPaths(source) {
  const paths = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(PATH)) {
      const before = line.slice(0, match.index)
      const quoted = before.endsWith('「')
      const segments = match[1]
        .split(/[›→]/)
        .map((segment) => segment.trim())
        .filter(Boolean)
      paths.push({
        line: index + 1,
        raw: `设置${match[1]}`.trim(),
        segments,
        arrow: match[1].includes('→'),
        quoted,
      })
    }
  }
  return paths
}

/**
 * Problems with the settings paths of one Markdown file: an arrow instead
 * of ›, a path outside 「」 (docs/design/writing.md), a first segment that
 * is no settings section, or a later one that appears nowhere in that
 * section's components.
 */
export function settingsPathProblems(source, navigation, file = '') {
  const problems = []
  for (const path of settingsPaths(source)) {
    const where = `${file}:${path.line}: 「${path.raw}」`
    if (path.arrow) problems.push(`${where} 用 › 分隔，不用 →`)
    if (!path.quoted) problems.push(`${where} 写成「设置 › …」，放在「」里`)
    const [first, ...rest] = path.segments
    const section = navigation.sections.get(first)
    if (!section) {
      problems.push(
        `${where} 「${first}」不是设置分区（${[...navigation.sections.keys()].join('、')}）`,
      )
      continue
    }
    for (const segment of rest)
      if (!section.names.has(segment))
        problems.push(`${where} 「${first}」里没有「${segment}」`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Core operations

/** The keys of CORE_OPERATION_REGISTRY, read from the source. */
export function coreOperations(root) {
  const source = readFileSync(join(root, OPERATIONS_FILE), 'utf8')
  const body = source.match(
    /export const CORE_OPERATION_REGISTRY = \{\n([\s\S]*?)\n\}/,
  )
  const keys = new Set()
  for (const match of (body?.[1] ?? '').matchAll(
    /^ {2}'?([a-zA-Z]+(?:\.[a-zA-Z]+)+)'?\s*:/gm,
  ))
    keys.add(match[1])
  return keys
}

/**
 * Names that look like `namespace.method` of the registry but are something
 * else, with what they are. Add one only for a name that really is no
 * operation.
 */
export const NOT_OPERATIONS = new Map([
  ['chat.runBackground', 'CoreApi 在 Core 进程内的方法，不经 IPC'],
  ['skills.folderPath', 'CoreApi 只给 main 的方法（打开 Skill 文件夹）'],
  ['plugins.logo', 'CoreApi 只给 main 的方法（app:// 读插件 Logo）'],
  ['tools.register', 'HarnessHost.compose() 里工具注册表的方法'],
  ['mcp.servers', 'MCP 导入格式里的 JSON 键'],
  ['sessions.defaultPermission', 'settings.json 的键'],
  ['workspace.fileCheckpoints', '旧内核 settings.json 的键（读取时忽略）'],
  ['workspace.gitRewind', '旧内核 settings.json 的键（读取时忽略）'],
  ['memory.hybridMemory', '旧内核 settings.json 的键（读取时忽略）'],
])

/**
 * Operations removed from the registry. A doc may name one only on a line
 * that says it is gone.
 */
export const REMOVED_OPERATIONS = new Set([
  'skills.previewInstall',
  'skills.confirmInstall',
  'skills.package',
  'computerUse.stop',
  'computerUse.resume',
])
const REMOVED_WORDS = /删除|移除|退役|不再|已无|不存在|取消了|去掉/

const FILE_SUFFIX =
  /^(?:json|jsonl|md|ts|tsx|js|mjs|cjs|vue|yml|yaml|sh|txt|lock|zip|log|plist|sb|el1|key|png|svg|webp|html|sqlite|toml|local|v\d+|d)$/i

/**
 * Operation-like names in the code spans of a Markdown text: `ns.method`
 * where ns is a namespace of the registry. `ns.a/b/c` names three, `ns.*`
 * names none, and file names (`config.json`) are skipped.
 */
export function operationMentions(source, operations) {
  const namespaces = new Set([...operations].map((key) => key.split('.')[0]))
  const mentions = []
  const lines = source.split('\n')
  let fenced = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    const spans = fenced
      ? [line]
      : [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    for (const span of spans) {
      for (const match of span.matchAll(
        /(?<![\w.$/-])([a-z][a-zA-Z]*)\.([a-zA-Z]+(?:\/[a-zA-Z]+)*)(?![\w-]|\.\w|\/)/g,
      )) {
        const [, namespace, methods] = match
        if (!namespaces.has(namespace)) continue
        for (const method of methods.split('/')) {
          if (FILE_SUFFIX.test(method)) continue
          mentions.push({ line: index + 1, name: `${namespace}.${method}` })
        }
      }
    }
  }
  return mentions
}

/** Operations named in a Markdown text that the registry does not have. */
export function coreOperationProblems(source, operations, file = '') {
  const lines = source.split('\n')
  return operationMentions(source, operations)
    .filter(({ name, line }) => {
      if (operations.has(name) || NOT_OPERATIONS.has(name)) return false
      return !(
        REMOVED_OPERATIONS.has(name) && REMOVED_WORDS.test(lines[line - 1])
      )
    })
    .map(
      ({ line, name }) =>
        `${file}:${line}: \`${name}\` 不是 Core 操作（${OPERATIONS_FILE}）`,
    )
}

// ---------------------------------------------------------------------------
// Private material

/**
 * Links (Markdown, reference definitions, HTML href/src) into private-docs/,
 * and paths inside it named anywhere. Naming the folder itself
 * (`private-docs/`) to explain the boundary is fine.
 */
export function privateReferenceProblems(source, file = '') {
  const problems = []
  for (const [index, line] of source.split('\n').entries()) {
    const targets = [
      ...[...line.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]),
      ...[...line.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)].map((m) => m[1]),
      ...[...line.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ]
    for (const target of targets)
      if (/private-docs/.test(target))
        problems.push(`${file}:${index + 1}: 链接到私有材料 ${target}`)
    if (/private-docs\/[\w.-]/.test(line))
      problems.push(`${file}:${index + 1}: 写出了私有材料里的路径`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Verification dates

/** `> 最后核验：YYYY-MM-DD（对照 `sha`）` → { date, commit }, else null. */
export function verificationOf(source) {
  const head = source.split('\n').slice(0, 12).join('\n')
  const match = head.match(
    /最后核验：(\d{4}-\d{2}-\d{2})(?:（对照 `([0-9a-f]{7,40})`）)?/,
  )
  return match ? { date: match[1], commit: match[2] ?? null } : null
}

/**
 * The text a verification covers: everything but the 最后核验 line, with
 * whitespace and the width of table rules ignored, so that reformatting
 * (prettier re-aligning a table) is no change.
 */
export function comparableText(source) {
  return source
    .split('\n')
    .filter((line) => !/最后核验：/.test(line))
    .map((line) =>
      /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line) ? '|-|' : line,
    )
    .join('\n')
    .replace(/\s+/g, '')
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function gitShow(root, revision, path) {
  try {
    return git(root, ['show', `${revision}:${path}`])
  } catch {
    return null
  }
}

/** Whether full history is here (CI checks out one or two commits). */
export function hasHistory(root) {
  try {
    return (
      git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'false'
    )
  } catch {
    return false
  }
}

/**
 * When the text of a file last changed: today when the working tree differs
 * from HEAD, else the author date of the newest non-merge commit that
 * changed it (reformatting does not count).
 */
export function lastTextChange(root, path, today) {
  const working = readFileSync(join(root, path), 'utf8')
  const committed = gitShow(root, 'HEAD', path)
  if (
    committed === null ||
    comparableText(committed) !== comparableText(working)
  )
    return { date: today, commit: null }
  const log = git(root, ['log', '--no-merges', '--format=%H %as', '--', path])
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const entry of log) {
    const [commit, date] = entry.split(' ')
    const after = gitShow(root, commit, path)
    const before = gitShow(root, `${commit}^`, path)
    if (after === null) continue
    if (before === null || comparableText(before) !== comparableText(after))
      return { date, commit }
  }
  return null
}

/** Today in local time, YYYY-MM-DD. */
export function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Problems with the 最后核验 lines of the given files: a date in the future,
 * a commit that does not exist, or text changed after the date. Without
 * full history (a shallow clone) only the first check runs.
 */
export function verificationProblems(root, files, today = localDate()) {
  const problems = []
  const history = hasHistory(root)
  for (const path of files) {
    const verified = verificationOf(readFileSync(join(root, path), 'utf8'))
    if (!verified) continue
    if (verified.date > today) {
      problems.push(`${path}: 最后核验 ${verified.date} 晚于今天 ${today}`)
      continue
    }
    if (!history) continue
    if (verified.commit) {
      try {
        git(root, ['cat-file', '-e', `${verified.commit}^{commit}`])
      } catch {
        problems.push(`${path}: 最后核验对照的提交 ${verified.commit} 不存在`)
      }
    }
    const changed = lastTextChange(root, path, today)
    if (changed && changed.date > verified.date)
      problems.push(
        `${path}: 正文在 ${changed.date}${changed.commit ? `（${changed.commit.slice(0, 8)}）` : '（未提交的改动）'}改过，最后核验仍是 ${verified.date}；对照事实源核验后更新它`,
      )
  }
  return problems
}

// ---------------------------------------------------------------------------

function trackedMarkdown(root) {
  return execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path && existsSync(join(root, path)))
    .sort()
}

/** The public documentation: README, SECURITY and docs/. */
function isPublicDoc(path) {
  return (
    path === 'README.md' ||
    path === '.github/SECURITY.md' ||
    path.startsWith('docs/')
  )
}

/**
 * The newest version section of the changelog: older ones describe the
 * interface as it was then.
 */
export function currentChangelog(source) {
  const starts = [...source.matchAll(/^## \[/gm)].map((match) => match.index)
  return starts.length > 1 ? source.slice(0, starts[1]) : source
}

/** Every rule above for the repository at `root`, grouped by rule. */
export function checkDocReferences(root, { today = localDate() } = {}) {
  const navigation = settingsNavigation(root)
  const operations = coreOperations(root)
  const tracked = trackedMarkdown(root)
  const files = tracked.filter(isPublicDoc)
  const result = { settings: [], operations: [], private: [], verified: [] }
  // Any tracked Markdown (asset notes, package READMEs too) stays clear of
  // private-docs/; the other rules hold for the public documentation.
  for (const path of tracked)
    result.private.push(
      ...privateReferenceProblems(readFileSync(join(root, path), 'utf8'), path),
    )
  for (const path of files) {
    const full = readFileSync(join(root, path), 'utf8')
    const source =
      path === 'docs/release/CHANGELOG.md' ? currentChangelog(full) : full
    result.operations.push(...coreOperationProblems(source, operations, path))
    result.settings.push(...settingsPathProblems(source, navigation, path))
  }
  result.verified.push(...verificationProblems(root, files, today))
  return result
}
