import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ERROR_MESSAGES, coreErrorDetail, coreErrorText } from './messages'

// UI-S10 test 4: every error code Core can send over IPC has Chinese text.
// The codes are read from the sources, so a new one fails here until it is
// added to messages.ts. Harness and Computer Use errors (HarnessError,
// UiError) have no toSafe(): they reach the model, and IPC turns them into
// an internal error.

const CORE = new URL('../../../../../packages/core/src/', import.meta.url)
  .pathname
const MAIN_IPC = new URL('../../../main/ipc.ts', import.meta.url).pathname

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (/\.ts$/.test(entry) && !/\.(test|d)\.ts$/.test(entry))
      out.push(path)
  }
  return out
}

const CODE = /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)$/
/** Union members that become codes, with the prefix Core puts in front. */
const CODE_UNIONS: Record<string, string> = {
  MCPConnectionErrorCode: '',
  SkillErrorCode: '',
  PluginPackageErrorKind: 'plugin_preview_',
  ModelProviderErrorKind: 'model_provider_',
}
/** Constructors whose first argument is the code. */
const CODE_FIRST = new Set([
  'WorkspaceOperationError',
  'GoalServiceError',
  'UpdateError',
])
/** Constructors whose third argument is the code (FIX-10). */
const CODE_THIRD = new Set(['CoreMutationGuardError'])

function publicCoreErrorCodes(): Set<string> {
  const files = sources(CORE).map((path) =>
    ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    ),
  )
  const literal = (node: ts.Node | undefined): string | null =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null
  // Every literal an argument can be: both sides of `??` / `||`, both
  // branches of `?:` (`code ?? (status === 403 ? 'a' : 'b')`).
  const literals = (node: ts.Node | undefined): string[] => {
    if (!node) return []
    const text = literal(node)
    if (text !== null) return [text]
    if (ts.isParenthesizedExpression(node)) return literals(node.expression)
    if (ts.isConditionalExpression(node))
      return [...literals(node.whenTrue), ...literals(node.whenFalse)]
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      return [...literals(node.left), ...literals(node.right)]
    return []
  }
  // The EmperorError family: every class that extends it, directly or not.
  const bases = new Map<string, string>()
  for (const sf of files)
    sf.forEachChild(function collect(node) {
      if (ts.isClassDeclaration(node) && node.name)
        for (const clause of node.heritageClauses ?? [])
          if (clause.token === ts.SyntaxKind.ExtendsKeyword)
            bases.set(node.name.text, clause.types[0]!.expression.getText(sf))
      node.forEachChild(collect)
    })
  const family = (name: string): boolean => {
    for (let at: string | undefined = name; at; at = bases.get(at))
      if (at === 'EmperorError') return true
    return false
  }
  const codes = new Set<string>()
  const add = (code: string | null) => {
    if (code && CODE.test(code)) codes.add(code)
  }
  for (const sf of files) {
    let inClass: string | null = null
    const visit = (node: ts.Node): void => {
      const outer = inClass
      if (ts.isClassDeclaration(node) && node.name) inClass = node.name.text
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const args = node.arguments ?? []
        if (CODE_FIRST.has(node.expression.text)) add(literal(args[0]))
        if (CODE_THIRD.has(node.expression.text)) add(literal(args[2]))
        if (node.expression.text === 'EmperorError') add(literal(args[1]))
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.SuperKeyword &&
        inClass &&
        family(inClass)
      )
        for (const code of literals(node.arguments[1])) add(code)
      // `readonly code = '…'` on an error class with its own toSafe().
      if (
        ts.isPropertyDeclaration(node) &&
        node.name.getText(sf) === 'code' &&
        inClass &&
        /Error$/.test(inClass)
      )
        add(literal(node.initializer))
      if (ts.isTypeAliasDeclaration(node) && node.name.text in CODE_UNIONS) {
        const prefix = CODE_UNIONS[node.name.text]!
        const members = ts.isUnionTypeNode(node.type)
          ? node.type.types
          : [node.type]
        for (const member of members)
          if (
            ts.isLiteralTypeNode(member) &&
            ts.isStringLiteral(member.literal)
          )
            add(prefix + member.literal.text)
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(sf) === 'ENVIRONMENT_ERROR_CODES' &&
        node.initializer
      ) {
        const list = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer
        if (ts.isArrayLiteralExpression(list))
          for (const element of list.elements) add(literal(element))
      }
      // DelegationError.toSafe(): its guidance table and the fallback code.
      if (
        inClass === 'DelegationError' &&
        ts.isVariableDeclaration(node) &&
        node.name.getText(sf) === 'guidance' &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      )
        for (const property of node.initializer.properties)
          if (property.name) add(property.name.getText(sf).replace(/['"]/g, ''))
      if (inClass === 'DelegationError' && ts.isStringLiteral(node))
        add(node.text === 'EXTERNAL_OPERATION_FAILED' ? node.text : null)
      ts.forEachChild(node, visit)
      inClass = outer
    }
    visit(sf)
  }
  // Main's own interruption codes (desktop/src/main/ipc.ts).
  const ipc = readFileSync(MAIN_IPC, 'utf8')
  const interruption =
    /function benignTurnInterruption[\s\S]*?\n}\n/.exec(ipc)?.[0] ?? ''
  for (const match of interruption.matchAll(/code: '([a-z_]+)'/g))
    add(match[1]!)
  return codes
}

const CJK = /[一-鿿]/

describe('Core error messages (UI-S10)', () => {
  const codes = publicCoreErrorCodes()

  it('reads a real code set from Core', () => {
    // Spot checks that the extraction sees each source of codes.
    for (const code of [
      'validation_error',
      'git_gh_unavailable',
      'mcp_transport_timeout',
      'skill_read_only',
      'plugin_preview_manifest_missing',
      'model_provider_rate_limit',
      'download_failed',
      'goal_not_found',
      'SESSION_REQUIRED',
      'invalid_core_arguments',
      'INTEGRATION_CONFLICT',
      'EXTERNAL_OPERATION_FAILED',
      'turn_busy',
    ])
      expect(codes, code).toContain(code)
    expect(codes.size).toBeGreaterThan(120)
  })

  it('4 · every public Core error code has Chinese text', () => {
    const missing = [...codes]
      .filter((code) => !(code in ERROR_MESSAGES))
      .sort()
    expect(missing).toEqual([])
    for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
      expect(CJK.test(text), code).toBe(true)
      expect(text, code).not.toMatch(/\b[a-z]+_[a-z_]+\b/)
    }
  })

  it('shows Core’s own message when it is already Chinese', () => {
    expect(
      coreErrorText({ code: 'plugin_not_found', message: '找不到这个插件' }),
    ).toBe('找不到这个插件')
  })

  it('shows the code’s text for an English message, never the bare code', () => {
    const text = coreErrorText({
      code: 'mcp_transport_timeout',
      message: "MCP server 'aihot' request timed out",
    })
    expect(text).toBe(ERROR_MESSAGES.mcp_transport_timeout)
    expect(text).not.toContain('mcp_transport_timeout')
    expect(text).not.toContain('timed out')
  })

  it('keeps the first line of a tool’s own output after the text', () => {
    expect(
      coreErrorText({
        code: 'git_command_failed',
        message: "fatal: couldn't find remote ref main\nhint: …",
      }),
    ).toBe(
      `${ERROR_MESSAGES.git_command_failed}：fatal: couldn't find remote ref main`,
    )
  })

  it('falls back to a general sentence for an unknown English error', () => {
    expect(
      coreErrorText({ code: 'brand_new_code', message: 'Something broke' }),
    ).toBe('操作没有完成。错误详情可以复制给开发者。')
    expect(
      coreErrorText({ message: 'Internal error', errorId: 'ipc_abc' }),
    ).toBe('发生内部错误，请查看日志。')
  })

  it('puts the code, the original message and the error id in the copyable detail', () => {
    expect(
      coreErrorDetail({
        code: 'mcp_transport_timeout',
        message: "MCP server 'aihot' request timed out",
        errorId: 'ipc_1',
      }),
    ).toBe(
      "mcp_transport_timeout · MCP server 'aihot' request timed out · ipc_1",
    )
    expect(coreErrorDetail({ message: 'Internal error' })).toBe(
      'Internal error',
    )
  })
})
