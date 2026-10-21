// Design documentation rules (docs/design/), used by check_public_docs.mjs:
// every page opens with the four-line status header of docs/DOCUMENTATION.md
// and is listed in both indexes (docs/design/README.md and docs/README.md).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HEADER = [
  {
    key: '文档状态',
    check: (value) => /^(Active|Superseded)\b/.test(value),
    hint: 'Active 或 Superseded',
  },
  { key: '面向读者', check: (value) => value.length > 0, hint: '读者' },
  {
    key: '最后核验',
    check: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    hint: 'YYYY-MM-DD',
  },
  {
    key: '事实源',
    check: (value) => value.length > 0,
    hint: '代码路径、schema 或测试',
  },
]

/**
 * Problems with a page's status header: after the `# title` line and one
 * blank line come four quoted lines, `> 文档状态：…<br>`, `> 面向读者：…<br>`,
 * `> 最后核验：YYYY-MM-DD<br>` and `> 事实源：…`.
 */
export function statusHeaderProblems(source) {
  const lines = source.split(/\r?\n/)
  if (!lines[0]?.startsWith('# ')) return ['第一行应是 `# 标题`']
  const problems = []
  let at = lines[1] === '' ? 2 : 1
  for (const [index, field] of HEADER.entries()) {
    const line = lines[at] ?? ''
    const prefix = `> ${field.key}：`
    if (!line.startsWith(prefix)) {
      problems.push(`缺少状态头的「${field.key}」行（应为 \`${prefix}…\`）`)
      continue
    }
    at += 1
    const last = index === HEADER.length - 1
    let value = line.slice(prefix.length).trim()
    if (!last) {
      if (!value.endsWith('<br>'))
        problems.push(`「${field.key}」行应以 <br> 结尾`)
      value = value.replace(/<br>$/, '').trim()
    }
    if (!field.check(value))
      problems.push(`「${field.key}」应写 ${field.hint}，现在是「${value}」`)
  }
  return problems
}

function linksTo(source, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\]\\((?:\\./)?${escaped}(?:#[^)]*)?\\)`).test(source)
}

/** Every rule above, for the repository at `root`; [] when all hold. */
export function checkDesignDocs(root) {
  const dir = join(root, 'docs/design')
  if (!existsSync(dir)) return ['docs/design/ 不存在']
  const pages = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
  const designIndex = readFileSync(join(dir, 'README.md'), 'utf8')
  const docsIndex = readFileSync(join(root, 'docs/README.md'), 'utf8')
  const problems = []
  for (const name of pages) {
    const path = `docs/design/${name}`
    const source = readFileSync(join(dir, name), 'utf8')
    for (const problem of statusHeaderProblems(source))
      problems.push(`${path}: ${problem}`)
    if (name === 'README.md') continue
    if (!linksTo(designIndex, name))
      problems.push(`${path}: 没有列在 docs/design/README.md`)
    if (!linksTo(docsIndex, `design/${name}`))
      problems.push(`${path}: 没有列在 docs/README.md`)
  }
  return problems
}
