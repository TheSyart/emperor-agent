/**
 * Copy audit (UI-S10): the user-visible strings of the renderer — template
 * text and visible attributes of every component, and the labels, titles
 * and descriptions written as constants — must be Chinese and must not use
 * the retired terms (docs/design/writing.md). Test-only: copy-audit.test.ts
 * runs it over the sources and over fixtures.
 */

import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'

/** Retired terms and what replaces them (writing.md › 术语). */
export const BANNED_TERMS: Readonly<Record<string, string>> = {
  子代理: '子智能体',
  执行器: '子智能体（或 Claude Code / Codex）',
  派工: '交给子智能体 / 派给子智能体',
  验收: '验证 / 检查',
  结果树: '成果',
}

/** Visible attributes of a template element. */
const VISIBLE_ATTRIBUTES = new Set([
  'title',
  'aria-label',
  'placeholder',
  'label',
  'description',
  'alt',
  'hint',
  'empty-text',
  'tooltip',
  'subtitle',
  'confirm-label',
  'cancel-label',
])

/** Object keys whose string value is shown to the user. */
const VISIBLE_KEYS = new Set([
  'label',
  'title',
  'description',
  'placeholder',
  'hint',
  'tooltip',
  'emptyText',
  'subtitle',
])

/** Functions that return what the UI shows (`reasoningLabel`, `stateTitle`…). */
const VISIBLE_FUNCTION = /(?:Label|Title|Text|Description|Caption|Summary)$/

/** Elements whose text is code, a command or a key, never prose. */
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp'])

/**
 * A `monospace` / `mono` field or badge holds a sample value (`npx`, a tool
 * name, an exit code), not prose: its text and placeholder are code too.
 */
const CODE_FLAGS = new Set(['monospace', 'mono'])

/** Product names written as several English words. */
const ALLOWED_PHRASES = ['Emperor Computer Helper', 'Pull Requests', 'Pull Request']

/**
 * Words that stay as they are: product and brand names, protocol and file
 * vocabulary, units. Compared case-sensitively after stripping punctuation.
 */
const ALLOWED_WORDS = new Set([
  'Emperor',
  'Agent',
  'Claude',
  'Code',
  'Codex',
  'GitHub',
  'GitLab',
  'DeepSeek',
  'OpenAI',
  'Anthropic',
  'ChatGPT',
  'Gemini',
  'Qwen',
  'Kimi',
  'Moonshot',
  'OpenRouter',
  'Ollama',
  'Chrome',
  'Edge',
  'Safari',
  'Finder',
  'macOS',
  'Mac',
  'Windows',
  'Linux',
  'iCloud',
  'Time',
  'Machine',
  'Dock',
  'MCP',
  'API',
  'Key',
  'URL',
  'HTTP',
  'HTTPS',
  'SSE',
  'SSH',
  'JSON',
  'YAML',
  'TOML',
  'CLI',
  'SDK',
  'PR',
  'Git',
  'git',
  'Skill',
  'Skills',
  'Hook',
  'Hooks',
  'Shell',
  'Plugin',
  'Markdown',
  'Diff',
  'diff',
  'Token',
  'token',
  'tokens',
  'Tokens',
  'stdio',
  'stdout',
  'stderr',
  'worktree',
  'Worktree',
  'cron',
  'Cron',
  'USD',
  'Esc',
  'Enter',
  'Tab',
  'Shift',
  'Option',
  'Cmd',
  'Ctrl',
  'Alt',
  'Max',
  'Pro',
  'Plus',
  'Team',
  'Beta',
  'beta',
  'ID',
  'id',
  'PDF',
  'PNG',
  'JPEG',
  'SVG',
  'WebP',
  'CSV',
  'OAuth',
  'Bearer',
  'TTFT',
  'Logo',
  'logo',
])

export type CopyFinding = {
  readonly file: string
  readonly where: string
  readonly text: string
  readonly kind: 'english' | 'banned'
}

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/

/** Is this visible string untranslated English (beyond allowed words)? */
export function isUntranslated(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim()
  if (!value || CJK.test(value)) return false
  let rest = value
  for (const phrase of ALLOWED_PHRASES) rest = rest.split(phrase).join(' ')
  rest = rest
    // URLs, paths, file names, flags, env vars, templates, numbers.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)[~./][\w./@~-]*/g, ' ')
    .replace(/[\w.-]+\.(?:md|json|toml|ya?ml|ts|js|py|zip|app|plist|txt|sh|log|jsonl|dmg|skill)\b/gi, ' ')
    .replace(/(?:^|\s)--?[\w-]+/g, ' ')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}|\$\{[\s\S]*?\}/g, ' ')
    .replace(/\b[\w-]+\/[\w./-]+/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|cn|org|net|io|dev|ai|app)\b/gi, ' ')
    // Reverse-DNS identifiers (bundle IDs: com.example.Writer).
    .replace(/\b(?:com|org|net|io|dev|app)\.[\w-]+(?:\.[\w-]+)+/g, ' ')
  const words = rest.match(/[A-Za-z][A-Za-z'-]*/g) ?? []
  return words.some((word) => word.length >= 3 && !ALLOWED_WORDS.has(word))
}

export function bannedTermsIn(text: string): string[] {
  return Object.keys(BANNED_TERMS).filter((term) => text.includes(term))
}

function classify(
  file: string,
  where: string,
  text: string,
  out: CopyFinding[],
  checkBanned = true,
): void {
  const value = text.replace(/\s+/g, ' ').trim()
  if (!value) return
  if (checkBanned && bannedTermsIn(value).length)
    out.push({ file, where, text: value, kind: 'banned' })
  if (isUntranslated(value)) out.push({ file, where, text: value, kind: 'english' })
}

/** Template text and visible attributes of one component. */
export function auditVue(file: string, source: string): CopyFinding[] {
  const out: CopyFinding[] = []
  const { descriptor } = parse(source, { filename: file })
  const ast = descriptor.template?.ast
  if (ast) {
    type Node = {
      type: number
      tag?: string
      content?: string
      props?: Array<{
        type: number
        name: string
        value?: { content: string }
      }>
      children?: Node[]
    }
    const visit = (node: Node, inCode: boolean): void => {
      if (node.type === 2 && !inCode && node.content)
        classify(file, 'text', node.content, out)
      const code =
        inCode ||
        (node.type === 1 &&
          (CODE_ELEMENTS.has(node.tag ?? '') ||
            (node.props ?? []).some(
              (prop) => prop.type === 6 && CODE_FLAGS.has(prop.name),
            )))
      if (node.type === 1)
        for (const prop of node.props ?? [])
          if (
            prop.type === 6 &&
            VISIBLE_ATTRIBUTES.has(prop.name) &&
            prop.value?.content &&
            !(code && prop.name === 'placeholder')
          )
            classify(file, prop.name, prop.value.content, out)
      for (const child of node.children ?? []) visit(child, code)
    }
    visit(ast as unknown as Node, false)
  }
  const script = descriptor.scriptSetup?.content ?? descriptor.script?.content
  if (script) out.push(...auditScript(file, script))
  return out
}

/** Visible string constants of a script (object keys and *Label functions). */
export function auditScript(file: string, source: string): CopyFinding[] {
  const out: CopyFinding[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  // A template literal counts by its fixed text (`Request #${n}` → `Request # `).
  const literal = (node: ts.Node | undefined): string | null => {
    if (!node) return null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text
    if (ts.isTemplateExpression(node))
      return [node.head, ...node.templateSpans.map((span) => span.literal)]
        .map((part) => part.text)
        .join(' ')
    return null
  }
  const visit = (node: ts.Node, fn: string | null): void => {
    // Retired terms are Chinese: every string literal can be checked.
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      bannedTermsIn(node.text).length
    )
      out.push({ file, where: 'string', text: node.text, kind: 'banned' })
    if (ts.isTemplateExpression(node))
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)])
        if (bannedTermsIn(part.text).length)
          out.push({ file, where: 'template', text: part.text, kind: 'banned' })
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sf).replace(/['"]/g, '')
      const value = literal(node.initializer)
      if (value !== null && VISIBLE_KEYS.has(key))
        classify(file, key, value, out, false)
    }
    let inner = fn
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name
    )
      inner = node.name.getText(sf)
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    )
      inner = node.name.getText(sf)
    if (ts.isReturnStatement(node) && inner && VISIBLE_FUNCTION.test(inner)) {
      const value = literal(node.expression)
      if (value !== null) classify(file, `${inner}()`, value, out, false)
    }
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(sf, null)
  return out
}
