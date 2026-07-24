import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export type ShellAstStatus = 'parsed' | 'invalid' | 'too_complex'

export type ShellAstFeature =
  | 'pipeline'
  | 'and'
  | 'or'
  | 'sequence'
  | 'background'
  | 'redirection'
  | 'heredoc'
  | 'here_string'
  | 'command_substitution'
  | 'process_substitution'
  | 'parameter_expansion'
  | 'arithmetic_expansion'
  | 'subshell'
  | 'brace_group'
  | 'control_flow'

export interface ShellAstRedirect {
  operator: string
  target: string
  fd: number | null
}

export interface ShellAstCommand {
  type: 'command'
  argv: string[]
  env: Array<{ name: string; value: string }>
  redirects: ShellAstRedirect[]
  nested: boolean
}

export interface ShellAstRoot {
  type: 'script'
  children: Array<
    | ShellAstCommand
    | { type: 'operator'; operator: string }
    | { type: 'dynamic'; feature: ShellAstFeature }
  >
}

export interface ShellAstAnalysis {
  version: 1
  parser: 'emperor-shell-ast-v1'
  status: ShellAstStatus
  root: ShellAstRoot
  commands: ShellAstCommand[]
  features: ShellAstFeature[]
  reasonCodes: string[]
  nodeCount: number
  fingerprint: string
}

export interface ShellAstSummary {
  parser: 'emperor-shell-ast-v1'
  status: ShellAstStatus
  features: ShellAstFeature[]
  reasonCodes: string[]
  commandCount: number
  redirectCount: number
  nodeCount: number
  readonly: boolean
  fingerprint: string
}

export type ShellCommandAnalyzer = (command: string) => ShellAstAnalysis

type WordToken = {
  kind: 'word'
  value: string
  start: number
  end: number
}
type OperatorToken = {
  kind: 'operator'
  value: string
  start: number
  end: number
}
type RedirectToken = {
  kind: 'redirect'
  value: string
  fd: number | null
  start: number
  end: number
}
type ShellToken = WordToken | OperatorToken | RedirectToken

interface ScanResult {
  tokens: ShellToken[]
  features: Set<ShellAstFeature>
  reasons: Set<string>
  nested: ShellAstCommand[]
  status: ShellAstStatus
}

const MAX_COMMAND_CHARS = 10_000
const MAX_AST_NODES = 512
const DYNAMIC_PLACEHOLDER = '__SHELL_DYNAMIC__'
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const CONTROL_FLOW_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'case',
  'esac',
  'do',
  'done',
  'function',
  'select',
  'coproc',
])
const FEATURE_ORDER: ShellAstFeature[] = [
  'pipeline',
  'and',
  'or',
  'sequence',
  'background',
  'redirection',
  'heredoc',
  'here_string',
  'command_substitution',
  'process_substitution',
  'parameter_expansion',
  'arithmetic_expansion',
  'subshell',
  'brace_group',
  'control_flow',
]

export function analyzeShellCommand(command: string): ShellAstAnalysis {
  const input = String(command ?? '')
  const preflightReasons = new Set<string>()
  let status: ShellAstStatus = 'parsed'
  if (!input.trim()) {
    preflightReasons.add('empty_command')
    status = 'invalid'
  }
  if (input.length > MAX_COMMAND_CHARS) {
    preflightReasons.add('command_too_long')
    status = 'too_complex'
  }
  // eslint-disable-next-line no-control-regex
  if (/\0|[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input)) {
    preflightReasons.add('control_character')
    status = 'invalid'
  }
  if (
    /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(
      input,
    )
  ) {
    preflightReasons.add('unicode_whitespace')
    status = 'invalid'
  }

  const scanned =
    status === 'parsed' ? scan(input, 0) : emptyScan(status, preflightReasons)
  for (const reason of preflightReasons) scanned.reasons.add(reason)
  if (status !== 'parsed') scanned.status = status
  const parsed = parseTokens(scanned.tokens, scanned)
  const commands = [...parsed.commands, ...scanned.nested]
  for (const commandNode of commands) {
    if (commandNode.argv.some((part) => part === DYNAMIC_PLACEHOLDER))
      scanned.reasons.add('dynamic_expansion')
    for (const argument of commandNode.argv.slice(1)) {
      if (isOutsidePathArgument(argument))
        scanned.reasons.add('outside_path_argument')
    }
    if (CONTROL_FLOW_WORDS.has(baseName(commandNode.argv[0] ?? ''))) {
      scanned.features.add('control_flow')
      scanned.reasons.add('compound_command')
    }
  }
  let nodeCount =
    parsed.root.children.length +
    commands.reduce(
      (sum, item) => sum + 1 + item.argv.length + item.redirects.length,
      0,
    )
  if (nodeCount > MAX_AST_NODES) {
    scanned.status = 'too_complex'
    scanned.reasons.add('ast_node_limit')
    nodeCount = MAX_AST_NODES
  }
  const features = FEATURE_ORDER.filter((feature) =>
    scanned.features.has(feature),
  )
  const reasonCodes = [...scanned.reasons].sort()
  const structural = {
    status: scanned.status,
    commands: commands.map((item) => ({
      argv: item.argv,
      env: item.env,
      redirects: item.redirects,
      nested: item.nested,
    })),
    features,
    reasonCodes,
  }
  return {
    version: 1,
    parser: 'emperor-shell-ast-v1',
    status: scanned.status,
    root: parsed.root,
    commands,
    features,
    reasonCodes,
    nodeCount,
    fingerprint: sha256(stableStringify(structural)),
  }
}

/**
 * Capability boundary used by permission actors/services. A parser adapter is
 * advisory evidence, so crashes and malformed adapter results must only remove
 * permissions; they can never promote a command to read-only.
 */
export function analyzeShellCommandFailClosed(
  command: string,
  analyzer: ShellCommandAnalyzer = analyzeShellCommand,
): ShellAstAnalysis {
  try {
    const analysis = analyzer(command)
    if (!isShellAstAnalysis(analysis))
      return failedAnalysis(command, 'parser_invalid_result')
    return analysis
  } catch {
    return failedAnalysis(command, 'parser_failure')
  }
}

export interface ShellReadonlyContext {
  readonly workspaceRoot?: string | null
  readonly cwd?: string | null
}

export function isShellAstReadonly(
  analysis: ShellAstAnalysis,
  context: ShellReadonlyContext = {},
): boolean {
  if (analysis.status !== 'parsed') return false
  if (analysis.features.length || analysis.reasonCodes.length) return false
  if (analysis.commands.length !== 1) return false
  const command = analysis.commands[0]!
  if (command.env.length || command.redirects.length || command.nested)
    return false
  return isReadonlyArgv(command.argv, context)
}

/**
 * Smart-auto read-only proof. Unlike the strict single-command predicate used
 * by ask mode, this accepts a bounded pipeline/sequence only when every parsed
 * command is independently read-only and no redirection or dynamic shell
 * feature is present.
 */
export function isShellAstReadonlySequence(
  analysis: ShellAstAnalysis,
  context: ShellReadonlyContext = {},
): boolean {
  if (analysis.status !== 'parsed' || !analysis.commands.length) return false
  const safeFeatures = new Set<ShellAstFeature>([
    'pipeline',
    'and',
    'or',
    'sequence',
  ])
  if (analysis.features.some((feature) => !safeFeatures.has(feature)))
    return false
  const safeReasons = new Set(['compound_command', 'outside_path_argument'])
  if (analysis.reasonCodes.some((reason) => !safeReasons.has(reason)))
    return false
  return analysis.commands.every(
    (command) =>
      !command.env.length &&
      !command.redirects.length &&
      !command.nested &&
      isReadonlyArgv(command.argv, context),
  )
}

/**
 * Core-level Git deny rules. These represent structural safety invariants, not
 * approval preferences, so full_access and user allow rules cannot override
 * them.
 */
export function gitShellExplicitDenyReason(
  analysis: ShellAstAnalysis,
  context: ShellReadonlyContext = {},
): string | null {
  if (analysis.status !== 'parsed') return null
  for (const command of analysis.commands) {
    const reason = gitArgvExplicitDenyReason(command.argv, context)
    if (reason) return reason
  }
  return null
}

export function shellAstSummary(analysis: ShellAstAnalysis): ShellAstSummary {
  return {
    parser: analysis.parser,
    status: analysis.status,
    features: [...analysis.features],
    reasonCodes: [...analysis.reasonCodes],
    commandCount: analysis.commands.length,
    redirectCount: analysis.commands.reduce(
      (sum, command) => sum + command.redirects.length,
      0,
    ),
    nodeCount: analysis.nodeCount,
    readonly: isShellAstReadonly(analysis),
    fingerprint: analysis.fingerprint,
  }
}

function scan(input: string, depth: number): ScanResult {
  const result: ScanResult = emptyScan('parsed')
  if (depth > 8) {
    result.status = 'too_complex'
    result.reasons.add('substitution_depth_limit')
    return result
  }
  let word = ''
  let wordStart = -1
  const flushWord = (end: number): void => {
    if (wordStart < 0) return
    result.tokens.push({
      kind: 'word',
      value: word,
      start: wordStart,
      end,
    })
    word = ''
    wordStart = -1
  }
  const append = (value: string, index: number): void => {
    if (wordStart < 0) wordStart = index
    word += value
  }

  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flushWord(index)
      continue
    }
    if (ch === '\n') {
      flushWord(index)
      pushOperator(result, '\n', index, index + 1)
      continue
    }
    if (ch === "'") {
      if (wordStart < 0) wordStart = index
      const closed = consumeSingleQuoted(input, index + 1)
      if (!closed) {
        result.status = 'invalid'
        result.reasons.add('unclosed_quote')
        break
      }
      word += closed.value
      index = closed.end
      continue
    }
    if (ch === '"') {
      if (wordStart < 0) wordStart = index
      const quoted = consumeDoubleQuoted(input, index + 1, depth, result)
      if (!quoted.closed) {
        result.status = 'invalid'
        result.reasons.add('unclosed_quote')
        break
      }
      word += quoted.value
      index = quoted.end
      continue
    }
    if (ch === '\\') {
      if (index + 1 >= input.length) {
        result.status = 'invalid'
        result.reasons.add('trailing_escape')
        break
      }
      if (input[index + 1] === '\n') {
        index += 1
        continue
      }
      append(input[index + 1]!, index)
      index += 1
      continue
    }
    if (ch === '`') {
      const substitution = consumeBackticks(input, index + 1)
      result.features.add('command_substitution')
      result.reasons.add('dynamic_expansion')
      append(DYNAMIC_PLACEHOLDER, index)
      if (!substitution.closed) {
        result.status = 'invalid'
        result.reasons.add('unclosed_substitution')
        break
      }
      mergeNested(result, substitution.value, depth)
      index = substitution.end
      continue
    }
    if (ch === '$') {
      const dynamic = consumeDollar(input, index, depth, result)
      if (dynamic) {
        append(DYNAMIC_PLACEHOLDER, index)
        index = dynamic.end
        continue
      }
    }
    if ((ch === '<' || ch === '>') && input[index + 1] === '(') {
      const substitution = consumeBalanced(input, index + 2)
      result.features.add('process_substitution')
      result.reasons.add('process_substitution')
      append(DYNAMIC_PLACEHOLDER, index)
      if (!substitution.closed) {
        result.status = 'invalid'
        result.reasons.add('unclosed_substitution')
        break
      }
      mergeNested(result, substitution.value, depth)
      index = substitution.end
      continue
    }
    const redirect = redirectAt(input, index)
    if (redirect) {
      flushWord(index)
      let fd: number | null = null
      const previous = result.tokens.at(-1)
      if (
        previous?.kind === 'word' &&
        previous.end === index &&
        /^\d+$/.test(previous.value)
      ) {
        fd = Number(previous.value)
        result.tokens.pop()
      }
      result.tokens.push({
        kind: 'redirect',
        value: redirect,
        fd,
        start: index,
        end: index + redirect.length,
      })
      result.features.add('redirection')
      if (redirect.startsWith('<<')) result.features.add('heredoc')
      if (redirect === '<<<') result.features.add('here_string')
      index += redirect.length - 1
      continue
    }
    const operator = operatorAt(input, index)
    if (operator) {
      flushWord(index)
      pushOperator(result, operator, index, index + operator.length)
      index += operator.length - 1
      continue
    }
    if (ch === '(' || ch === ')') {
      flushWord(index)
      result.features.add('subshell')
      result.reasons.add('compound_command')
      result.tokens.push({
        kind: 'operator',
        value: ch,
        start: index,
        end: index + 1,
      })
      continue
    }
    if (ch === '{' || ch === '}') {
      flushWord(index)
      result.features.add('brace_group')
      result.reasons.add('compound_command')
      result.tokens.push({
        kind: 'operator',
        value: ch,
        start: index,
        end: index + 1,
      })
      continue
    }
    append(ch, index)
  }
  flushWord(input.length)
  return result
}

function parseTokens(
  tokens: ShellToken[],
  scanned: ScanResult,
): { root: ShellAstRoot; commands: ShellAstCommand[] } {
  const root: ShellAstRoot = { type: 'script', children: [] }
  const commands: ShellAstCommand[] = []
  let words: string[] = []
  let redirects: ShellAstRedirect[] = []
  let pendingRedirect: RedirectToken | null = null
  const flush = (): void => {
    if (!words.length && !redirects.length) return
    const env: Array<{ name: string; value: string }> = []
    while (words.length) {
      const assignment = ENV_ASSIGNMENT.exec(words[0]!)
      if (!assignment) break
      env.push({ name: assignment[1]!, value: assignment[2] ?? '' })
      words.shift()
    }
    if (words.length) {
      const command: ShellAstCommand = {
        type: 'command',
        argv: words,
        env,
        redirects,
        nested: false,
      }
      commands.push(command)
      root.children.push(command)
    } else {
      scanned.reasons.add('missing_command')
    }
    words = []
    redirects = []
  }

  for (const token of tokens) {
    if (token.kind === 'word') {
      if (pendingRedirect) {
        redirects.push({
          operator: pendingRedirect.value,
          target: token.value,
          fd: pendingRedirect.fd,
        })
        pendingRedirect = null
      } else {
        words.push(token.value)
      }
      continue
    }
    if (token.kind === 'redirect') {
      if (pendingRedirect) scanned.reasons.add('missing_redirect_target')
      pendingRedirect = token
      continue
    }
    if (pendingRedirect) {
      scanned.reasons.add('missing_redirect_target')
      pendingRedirect = null
    }
    flush()
    root.children.push({ type: 'operator', operator: token.value })
  }
  if (pendingRedirect) scanned.reasons.add('missing_redirect_target')
  flush()
  return { root, commands }
}

function consumeDollar(
  input: string,
  index: number,
  depth: number,
  result: ScanResult,
): { end: number } | null {
  const next = input[index + 1]
  if (next === '(') {
    if (input[index + 2] === '(') {
      const arithmetic = consumeArithmetic(input, index + 3)
      result.features.add('arithmetic_expansion')
      result.reasons.add('dynamic_expansion')
      if (!arithmetic.closed) {
        result.status = 'invalid'
        result.reasons.add('unclosed_substitution')
      }
      return { end: arithmetic.end }
    }
    const substitution = consumeBalanced(input, index + 2)
    result.features.add('command_substitution')
    result.reasons.add('dynamic_expansion')
    if (!substitution.closed) {
      result.status = 'invalid'
      result.reasons.add('unclosed_substitution')
    } else {
      mergeNested(result, substitution.value, depth)
    }
    return { end: substitution.end }
  }
  if (next === '{') {
    const end = input.indexOf('}', index + 2)
    result.features.add('parameter_expansion')
    result.reasons.add('dynamic_expansion')
    if (end < 0) {
      result.status = 'invalid'
      result.reasons.add('unclosed_substitution')
      return { end: input.length - 1 }
    }
    return { end }
  }
  if (next && /[A-Za-z0-9_?$!#*@-]/.test(next)) {
    let end = index + 1
    while (end + 1 < input.length && /[A-Za-z0-9_]/.test(input[end + 1]!))
      end += 1
    result.features.add('parameter_expansion')
    result.reasons.add('dynamic_expansion')
    return { end }
  }
  return null
}

function consumeDoubleQuoted(
  input: string,
  start: number,
  depth: number,
  result: ScanResult,
): { value: string; end: number; closed: boolean } {
  let value = ''
  for (let index = start; index < input.length; index++) {
    const ch = input[index]!
    if (ch === '"') return { value, end: index, closed: true }
    if (ch === '\\') {
      const next = input[index + 1]
      if (next === undefined) break
      if (next === '\n') {
        index += 1
        continue
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        value += next
        index += 1
        continue
      }
      value += `\\${next}`
      index += 1
      continue
    }
    if (ch === '`') {
      const substitution = consumeBackticks(input, index + 1)
      result.features.add('command_substitution')
      result.reasons.add('dynamic_expansion')
      value += DYNAMIC_PLACEHOLDER
      if (!substitution.closed)
        return { value, end: input.length - 1, closed: false }
      mergeNested(result, substitution.value, depth)
      index = substitution.end
      continue
    }
    if (ch === '$') {
      const dynamic = consumeDollar(input, index, depth, result)
      if (dynamic) {
        value += DYNAMIC_PLACEHOLDER
        index = dynamic.end
        continue
      }
    }
    value += ch
  }
  return { value, end: input.length - 1, closed: false }
}

function consumeSingleQuoted(
  input: string,
  start: number,
): { value: string; end: number } | null {
  const end = input.indexOf("'", start)
  return end < 0 ? null : { value: input.slice(start, end), end }
}

function consumeBackticks(
  input: string,
  start: number,
): { value: string; end: number; closed: boolean } {
  let escaped = false
  for (let index = start; index < input.length; index++) {
    const ch = input[index]!
    if (!escaped && ch === '`')
      return { value: input.slice(start, index), end: index, closed: true }
    escaped = !escaped && ch === '\\'
    if (ch !== '\\') escaped = false
  }
  return { value: '', end: input.length - 1, closed: false }
}

function consumeBalanced(
  input: string,
  start: number,
): { value: string; end: number; closed: boolean } {
  let depth = 1
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let index = start; index < input.length; index++) {
    const ch = input[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0)
        return {
          value: input.slice(start, index),
          end: index,
          closed: true,
        }
    }
  }
  return { value: '', end: input.length - 1, closed: false }
}

function consumeArithmetic(
  input: string,
  start: number,
): { end: number; closed: boolean } {
  for (let index = start; index < input.length - 1; index++) {
    if (input[index] === ')' && input[index + 1] === ')')
      return { end: index + 1, closed: true }
  }
  return { end: input.length - 1, closed: false }
}

function mergeNested(result: ScanResult, input: string, depth: number): void {
  const nested = scan(input, depth + 1)
  const parsed = parseTokens(nested.tokens, nested)
  result.nested.push(
    ...parsed.commands.map((command) => ({ ...command, nested: true })),
    ...nested.nested,
  )
  nested.features.forEach((feature) => result.features.add(feature))
  nested.reasons.forEach((reason) => result.reasons.add(reason))
  if (nested.status !== 'parsed') result.status = nested.status
}

function pushOperator(
  result: ScanResult,
  value: string,
  start: number,
  end: number,
): void {
  result.tokens.push({ kind: 'operator', value, start, end })
  if (value === '|' || value === '|&') result.features.add('pipeline')
  else if (value === '&&') result.features.add('and')
  else if (value === '||') result.features.add('or')
  else if (value === '&') result.features.add('background')
  else result.features.add('sequence')
  result.reasons.add('compound_command')
}

function redirectAt(input: string, index: number): string | null {
  for (const operator of [
    '&>>',
    '<<<',
    '&>',
    '>>',
    '<<',
    '>&',
    '<&',
    '>|',
    '>',
    '<',
  ]) {
    if (input.startsWith(operator, index)) return operator
  }
  return null
}

function operatorAt(input: string, index: number): string | null {
  for (const operator of ['&&', '||', '|&', ';', '|', '&']) {
    if (input.startsWith(operator, index)) return operator
  }
  return null
}

function isReadonlyArgv(
  argv: string[],
  context: ShellReadonlyContext,
): boolean {
  if (!argv.length) return false
  const head = baseName(argv[0]!)
  if (head === 'echo' || head === 'printf') return true
  if (['cat', 'grep', 'head', 'tail', 'wc'].includes(head)) {
    const operands = readonlyFileOperands(head, argv.slice(1))
    return (
      operands !== null &&
      operands.length > 0 &&
      operands.every((operand) => isProvenWorkspacePath(operand, context))
    )
  }
  if (head === 'pwd')
    return argv
      .slice(1)
      .every((argument) => argument === '-L' || argument === '-P')
  if (head === 'ls')
    return argv
      .slice(1)
      .every((argument) => argument === '.' || /^-[A-Za-z]+$/.test(argument))
  if (head !== 'git') return false

  let index = 1
  while (index < argv.length) {
    const argument = argv[index]
    if (argument === '--no-pager' || argument === '--literal-pathspecs') {
      index += 1
      continue
    }
    if (argument === '-C') {
      const directory = argv[index + 1] ?? ''
      if (!isProvenWorkspacePath(directory, context)) return false
      index += 2
      continue
    }
    break
  }
  const subcommand = argv[index]
  if (!subcommand) return false
  const args = argv.slice(index + 1)
  if (subcommand === 'status')
    return !args.some(
      (argument) =>
        argument === '--help' ||
        argument === '-h' ||
        argument === '--config' ||
        argument.startsWith('--config='),
    )
  if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show') {
    if (
      args.some(
        (argument) =>
          argument === '--ext-diff' ||
          argument === '--help' ||
          argument === '-h' ||
          argument === '--textconv' ||
          argument === '--no-textconv' ||
          argument === '--output' ||
          argument.startsWith('--output='),
      )
    )
      return false
    if (subcommand === 'diff' && args.includes('--no-index')) {
      const separator = args.indexOf('--')
      const operands = (
        separator >= 0
          ? args.slice(separator + 1)
          : args.filter((argument) => !argument.startsWith('-'))
      ).slice(-2)
      return (
        operands.length === 2 &&
        operands.every((operand) => isProvenWorkspacePath(operand, context))
      )
    }
    return true
  }
  if (subcommand === 'branch') {
    if (!args.length) return true
    const mutating = new Set([
      '-d',
      '-D',
      '-m',
      '-M',
      '-c',
      '-C',
      '--delete',
      '--move',
      '--copy',
      '--edit-description',
      '--set-upstream-to',
      '--unset-upstream',
    ])
    if (args.some((argument) => mutating.has(argument))) return false
    const permitsPatterns = args.some(
      (argument) => argument === '--list' || argument.startsWith('--list='),
    )
    return args.every((argument) => argument.startsWith('-')) || permitsPatterns
  }
  return false
}

function gitArgvExplicitDenyReason(
  argv: string[],
  context: ShellReadonlyContext,
): string | null {
  if (baseName(argv[0] ?? '') !== 'git') return null
  let index = 1
  while (index < argv.length) {
    const argument = argv[index] ?? ''
    if (argument === '--no-pager' || argument === '--literal-pathspecs') {
      index += 1
      continue
    }
    if (argument === '-C') {
      const directory = argv[index + 1] ?? ''
      if (!isProvenWorkspacePath(directory, context))
        return 'repository_override'
      index += 2
      continue
    }
    if (
      argument === '-c' ||
      argument.startsWith('-c') ||
      argument === '--config-env' ||
      argument.startsWith('--config-env=')
    )
      return 'dynamic_config'
    if (
      argument === '--git-dir' ||
      argument.startsWith('--git-dir=') ||
      argument === '--work-tree' ||
      argument.startsWith('--work-tree=')
    )
      return 'repository_override'
    break
  }
  const subcommand = String(argv[index] ?? '').toLowerCase()
  const args = argv.slice(index + 1)
  if (!subcommand) return null

  if (
    subcommand === 'push' &&
    args.some(
      (argument) =>
        argument === '-f' ||
        argument === '--force' ||
        argument === '--force-with-lease' ||
        argument.startsWith('--force-with-lease=') ||
        argument === '--force-if-includes',
    )
  )
    return 'force_push'

  if (
    subcommand === 'reset' ||
    subcommand === 'rebase' ||
    subcommand === 'filter-branch' ||
    (subcommand === 'commit' &&
      args.some(
        (argument) => argument === '--amend' || argument.startsWith('--fixup='),
      ))
  )
    return 'history_rewrite'

  if (
    args.some(
      (argument) =>
        argument === '--no-verify' ||
        argument === '--no-hooks' ||
        argument.startsWith('--hooks-path='),
    )
  )
    return 'hooks_bypass'

  if (
    subcommand === 'config' ||
    [
      'update-ref',
      'symbolic-ref',
      'replace',
      'prune',
      'gc',
      'reflog',
      'pack-refs',
      'commit-tree',
      'mktree',
    ].includes(subcommand) ||
    (subcommand === 'hash-object' && args.includes('-w'))
  )
    return 'git_internal_write'

  if (
    ['diff', 'show', 'log'].includes(subcommand) &&
    args.some(
      (argument) =>
        argument === '--ext-diff' ||
        argument === '--textconv' ||
        argument === '--no-textconv' ||
        argument === '--output' ||
        argument.startsWith('--output='),
    )
  )
    return subcommand === 'diff' &&
      args.some(
        (argument) =>
          argument === '--output' || argument.startsWith('--output='),
      )
      ? 'output_redirection'
      : 'external_diff'

  if (subcommand === 'diff' && args.includes('--no-index')) {
    const separator = args.indexOf('--')
    const operands = (
      separator >= 0
        ? args.slice(separator + 1)
        : args.filter((argument) => !argument.startsWith('-'))
    ).slice(-2)
    if (
      operands.length !== 2 ||
      operands.some((operand) => !isProvenWorkspacePath(operand, context))
    )
      return 'no_index_containment'
  }
  return null
}

function readonlyFileOperands(head: string, args: string[]): string[] | null {
  if (head === 'grep') return grepFileOperands(args)
  const operands: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (argument === '-' || argument.startsWith('~')) return null
    if (argument.startsWith('-')) {
      if (head === 'cat' && /^-[AbEnsTuv]+$/.test(argument)) continue
      if (head === 'wc' && /^-[clmwL]+$/.test(argument)) continue
      if (
        (head === 'head' || head === 'tail') &&
        (/^-\d+$/.test(argument) || /^--(?:lines|bytes)=\d+$/.test(argument))
      )
        continue
      if (
        (head === 'head' || head === 'tail') &&
        (argument === '-n' || argument === '-c')
      ) {
        if (!/^\+?-?\d+$/.test(args[index + 1] ?? '')) return null
        index += 1
        continue
      }
      return null
    }
    operands.push(argument)
  }
  return operands
}

function grepFileOperands(args: string[]): string[] | null {
  const files: string[] = []
  let patternSeen = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--') {
      const rest = args.slice(index + 1)
      if (!patternSeen) {
        if (!rest.length) return null
        rest.shift()
        patternSeen = true
      }
      files.push(...rest)
      break
    }
    if (argument === '-' || argument.startsWith('~')) return null
    if (argument === '-e' || argument === '--regexp') {
      if (args[index + 1] === undefined) return null
      patternSeen = true
      index += 1
      continue
    }
    if (argument === '-m' || argument === '--max-count') {
      if (!/^\d+$/.test(args[index + 1] ?? '')) return null
      index += 1
      continue
    }
    if (
      /^-[EFGHhIiLlnoqsvwxc]+$/.test(argument) ||
      /^--(?:extended-regexp|fixed-strings|basic-regexp|ignore-case|invert-match|word-regexp|line-regexp|count|line-number|files-with-matches|files-without-match|quiet|silent|no-messages|with-filename|no-filename)$/.test(
        argument,
      ) ||
      /^--max-count=\d+$/.test(argument) ||
      argument.startsWith('--regexp=')
    ) {
      if (argument.startsWith('--regexp=')) patternSeen = true
      continue
    }
    if (argument.startsWith('-')) return null
    if (!patternSeen) {
      patternSeen = true
      continue
    }
    files.push(argument)
  }
  return patternSeen ? files : null
}

function isProvenWorkspacePath(
  operand: string,
  context: ShellReadonlyContext,
): boolean {
  if (
    !operand ||
    operand === '-' ||
    operand.startsWith('~') ||
    operand.includes('\0') ||
    /[*?[\]{}]/.test(operand)
  )
    return false
  const workspaceRoot = canonicalExistingPath(context.workspaceRoot ?? '')
  if (!workspaceRoot) return false
  const cwd = canonicalExistingPath(context.cwd ?? workspaceRoot)
  if (!cwd || !pathWithin(cwd, workspaceRoot)) return false
  const candidate = canonicalExistingPath(
    isAbsolute(operand) ? operand : resolve(cwd, operand),
  )
  return Boolean(candidate && pathWithin(candidate, workspaceRoot))
}

function canonicalExistingPath(value: string): string | null {
  if (!value) return null
  try {
    return realpathSync.native(resolve(value))
  } catch {
    return null
  }
}

function pathWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isOutsidePathArgument(argument: string): boolean {
  const value = argument.replace(/\\/g, '/')
  return Boolean(
    value.startsWith('/') ||
    value.startsWith('~/') ||
    value.startsWith('//') ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../'),
  )
}

function emptyScan(
  status: ShellAstStatus,
  reasons: Set<string> = new Set(),
): ScanResult {
  return {
    tokens: [],
    features: new Set(),
    reasons,
    nested: [],
    status,
  }
}

function baseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').pop() || value
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function failedAnalysis(command: string, reason: string): ShellAstAnalysis {
  const structural = {
    status: 'invalid',
    reasonCodes: [reason],
    inputFingerprint: sha256(String(command ?? '')),
  }
  return {
    version: 1,
    parser: 'emperor-shell-ast-v1',
    status: 'invalid',
    root: { type: 'script', children: [] },
    commands: [],
    features: [],
    reasonCodes: [reason],
    nodeCount: 0,
    fingerprint: sha256(stableStringify(structural)),
  }
}

function isShellAstAnalysis(value: unknown): value is ShellAstAnalysis {
  if (!value || typeof value !== 'object') return false
  const analysis = value as Partial<ShellAstAnalysis>
  return (
    analysis.version === 1 &&
    analysis.parser === 'emperor-shell-ast-v1' &&
    (analysis.status === 'parsed' ||
      analysis.status === 'invalid' ||
      analysis.status === 'too_complex') &&
    Boolean(analysis.root && analysis.root.type === 'script') &&
    Array.isArray(analysis.commands) &&
    Array.isArray(analysis.features) &&
    Array.isArray(analysis.reasonCodes) &&
    Number.isFinite(analysis.nodeCount) &&
    typeof analysis.fingerprint === 'string'
  )
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
