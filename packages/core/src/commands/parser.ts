export class CommandParseError extends Error {
  readonly code = 'command_parse_error'

  constructor(message: string) {
    super(message)
    this.name = 'CommandParseError'
  }
}

export interface ParsedCommandInput {
  raw: string
  name: string
  args: string[]
  options: Record<string, string | boolean>
  tokens: string[]
}

export function tokenizeCommandInput(input: string): string[] {
  const text = String(input ?? '').trim()
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  let tokenStarted = false

  for (const char of text) {
    if (escaped) {
      current += char
      tokenStarted = true
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      tokenStarted = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      tokenStarted = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }
    current += char
    tokenStarted = true
  }
  if (escaped) current += '\\'
  if (quote) throw new CommandParseError('斜杠命令包含未闭合的引号。')
  if (tokenStarted) tokens.push(current)
  return tokens
}

export function parseCommandInput(input: string): ParsedCommandInput | null {
  const raw = String(input ?? '').trim()
  if (!raw.startsWith('/')) return null
  const tokens = tokenizeCommandInput(raw)
  const commandToken = tokens[0] ?? ''
  if (!commandToken.startsWith('/') || isAbsolutePathToken(commandToken))
    return null
  const name = commandToken.slice(1).trim().toLowerCase()
  if (!name || !/^[a-z0-9][a-z0-9_.:-]*$/i.test(name)) return null

  const args: string[] = []
  const options: Record<string, string | boolean> = {}
  let optionMode = true
  for (const token of tokens.slice(1)) {
    if (optionMode && token === '--') {
      optionMode = false
      continue
    }
    if (optionMode && /^--[a-z0-9][a-z0-9_-]*(?:=.*)?$/i.test(token)) {
      const body = token.slice(2)
      const equals = body.indexOf('=')
      if (equals < 0) options[body] = true
      else options[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }
    args.push(token)
  }
  return { raw, name, args, options, tokens }
}

function isAbsolutePathToken(token: string): boolean {
  if (!token.startsWith('/') || token === '/') return false
  return token.slice(1).includes('/')
}
