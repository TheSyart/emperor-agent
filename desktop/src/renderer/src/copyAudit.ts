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

const kebab = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

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
  // The grey text at the end of a picker row (`项目 Skill`).
  'meta',
  'tags',
])

/** Other keys that name what they show (`sourceLabel`, `emptyTitle`). */
const VISIBLE_KEY = /(?:Label|Title)$/

/**
 * Functions that return what the UI shows (`reasoningLabel`, `stateTitle`…),
 * and computeds named for it (`const label = computed(…)`).
 */
const VISIBLE_FUNCTION =
  /(?:^(?:label|title|text|description|caption|summary)|Label|Title|Text|Description|Caption|Summary)$/

/** Tables of shown text: `BUILTIN_TITLES`, `STEP_TITLE`, `stateLabels`. */
const VISIBLE_TABLE = /(?:titles?|labels?|captions?)$/i

/** Elements whose text is code, a command or a key, never prose. */
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp'])

/**
 * A `monospace` / `mono` field or badge holds a sample value (`npx`, a tool
 * name, an exit code), not prose: its text and placeholder are code too.
 */
const CODE_FLAGS = new Set(['monospace', 'mono'])

/** Product names written as several English words. */
const ALLOWED_PHRASES = [
  'Emperor Computer Helper',
  'Pull Requests',
  'Pull Request',
  // Wire protocols, by their own names (设置 › 模型 › 协议).
  'OpenAI Chat Completions',
  'Anthropic Messages',
]

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
  'Ralph',
  'Unix',
  'logo',
])

export type CopyFinding = {
  readonly file: string
  readonly where: string
  readonly text: string
  readonly kind: 'english' | 'banned'
}

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/

/** A whole command line (`git pull --ff-only`, `gh auth login`): code. */
const COMMAND_LINE =
  /^(?:git (?:fetch|pull|push|status|commit|checkout|switch|branch|merge|rebase|log|diff|clone|config|add|reset|worktree|remote|restore|init)|gh (?:auth|pr|repo|issue|run|api|release))(?: [\w./@=:-]+)*$/

/** Is this visible string untranslated English (beyond allowed words)? */
export function isUntranslated(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim()
  if (!value || CJK.test(value) || COMMAND_LINE.test(value)) return false
  let rest = value
  for (const phrase of ALLOWED_PHRASES) rest = rest.split(phrase).join(' ')
  rest = rest
    // URLs, paths, file names, flags, env vars, templates, numbers.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)[~./][\w./@~-]*/g, ' ')
    .replace(
      /[\w.-]+\.(?:md|json|toml|ya?ml|ts|js|py|zip|app|plist|txt|sh|log|jsonl|dmg|skill)\b/gi,
      ' ',
    )
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
  if (isUntranslated(value))
    out.push({ file, where, text: value, kind: 'english' })
}

/**
 * The strings an expression can display: itself, both branches of `?:`,
 * both sides of `||` / `??` / `+`, the fixed text of a template literal.
 * Comparison operands and call arguments (`state === 'running'`) are not.
 */
function shownStrings(node: ts.Expression): string[] {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return shownStrings(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text]
  if (ts.isTemplateExpression(node))
    return [
      [node.head, ...node.templateSpans.map((span) => span.literal)]
        .map((part) => part.text)
        .join(' '),
    ]
  if (ts.isConditionalExpression(node))
    return [...shownStrings(node.whenTrue), ...shownStrings(node.whenFalse)]
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.PlusToken,
    ].includes(node.operatorToken.kind)
  )
    return [...shownStrings(node.left), ...shownStrings(node.right)]
  return []
}

/** The shown strings of a template expression (`:title="…"`, `{{ … }}`). */
function shownInExpression(expression: string): string[] {
  const sf = ts.createSourceFile(
    'x.ts',
    `(${expression})`,
    ts.ScriptTarget.Latest,
    true,
  )
  const statement = sf.statements[0]
  return statement && ts.isExpressionStatement(statement)
    ? shownStrings(statement.expression)
    : []
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
      content?: string | { content: string }
      props?: Array<{
        type: number
        name: string
        value?: { content: string }
        arg?: { content: string }
        exp?: { content: string }
      }>
      children?: Node[]
    }
    const visit = (node: Node, inCode: boolean): void => {
      if (node.type === 2 && !inCode && typeof node.content === 'string')
        classify(file, 'text', node.content, out)
      // {{ … }}: the strings the expression shows.
      if (node.type === 5 && !inCode && typeof node.content === 'object')
        for (const text of shownInExpression(node.content.content))
          classify(file, 'text', text, out)
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
          // :title="…" and other bound visible attributes.
          else if (
            prop.type === 7 &&
            prop.name === 'bind' &&
            prop.arg &&
            VISIBLE_ATTRIBUTES.has(kebab(prop.arg.content)) &&
            prop.exp &&
            !(code && prop.arg.content === 'placeholder')
          )
            for (const text of shownInExpression(prop.exp.content))
              classify(file, `:${prop.arg.content}`, text, out)
      for (const child of node.children ?? []) visit(child, code)
    }
    visit(ast as unknown as Node, false)
  }
  const script = descriptor.scriptSetup?.content ?? descriptor.script?.content
  if (script) out.push(...auditScript(file, script))
  return out
}

/** The shown values of a table initializer (an object or `new Map([...])`). */
function tableValues(node: ts.Expression): string[] {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    node = node.expression
  if (ts.isObjectLiteralExpression(node))
    return node.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) &&
      !VISIBLE_KEYS.has(property.name.getText().replace(/['"]/g, ''))
        ? shownStrings(property.initializer)
        : [],
    )
  const [entries] =
    ts.isNewExpression(node) && node.expression.getText() === 'Map'
      ? (node.arguments ?? [])
      : []
  if (!entries || !ts.isArrayLiteralExpression(entries)) return []
  return entries.elements.flatMap((pair) =>
    ts.isArrayLiteralExpression(pair) && pair.elements[1]
      ? shownStrings(pair.elements[1])
      : [],
  )
}

/** Visible string constants of a script (object keys and *Label functions). */
export function auditScript(file: string, source: string): CopyFinding[] {
  const out: CopyFinding[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node, fn: string | null): void => {
    // Retired terms are Chinese: every string literal can be checked.
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      bannedTermsIn(node.text).length
    )
      out.push({ file, where: 'string', text: node.text, kind: 'banned' })
    if (ts.isTemplateExpression(node))
      for (const part of [
        node.head,
        ...node.templateSpans.map((span) => span.literal),
      ])
        if (bannedTermsIn(part.text).length)
          out.push({ file, where: 'template', text: part.text, kind: 'banned' })
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sf).replace(/['"]/g, '')
      if (VISIBLE_KEYS.has(key) || VISIBLE_KEY.test(key))
        for (const value of shownStrings(node.initializer))
          classify(file, key, value, out, false)
    }
    // A table of shown text: every value of `{ key: '…' }`, and the second
    // item of every `[key, '…']` pair of `new Map([...])`.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      VISIBLE_TABLE.test(node.name.getText(sf))
    ) {
      const table = node.name.getText(sf)
      for (const value of tableValues(node.initializer))
        classify(file, table, value, out, false)
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
        ts.isFunctionExpression(node.initializer) ||
        // const stateLabel = computed(() => …)
        (ts.isCallExpression(node.initializer) &&
          node.initializer.expression.getText(sf) === 'computed'))
    )
      inner = node.name.getText(sf)
    // An arrow function's expression body is what it returns.
    if (
      ts.isArrowFunction(node) &&
      !ts.isBlock(node.body) &&
      inner &&
      VISIBLE_FUNCTION.test(inner)
    )
      for (const value of shownStrings(node.body))
        classify(file, `${inner}()`, value, out, false)
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      inner &&
      VISIBLE_FUNCTION.test(inner)
    )
      for (const value of shownStrings(node.expression))
        classify(file, `${inner}()`, value, out, false)
    ts.forEachChild(node, (child) => visit(child, inner))
  }
  visit(sf, null)
  return out
}
