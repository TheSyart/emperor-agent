/**
 * 命令安全判定纯函数 (MIG-TOOL-005)。
 * 对齐 Python `agent/permissions/resolvers.py`。Shell/权限管线共用。
 */

const HIGH_RISK_FALLBACK =
  /(\bgit\s+push\b|\bgh\s+(pr\s+merge|release|workflow|run)\b|\brm\s+(-[^\s]*r|-[^\s]*f|--recursive|--force)\b|\bsudo\b|\bchmod\b|\bchown\b|\bdeploy\b|\bpublish\b|\brelease\b|\bnpm\s+(install|publish)\b|\bpip\s+install\b|\bbrew\s+install\b|\bdocker\s+(push|compose\s+up|run)\b|\bkubectl\b|\bterraform\s+(apply|destroy)\b)/i

// Strictly inspection-only, no code execution. Used by plan guard to pass probes.
const READONLY_SINGLE = new Set(['ls', 'pwd'])
const READONLY_GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch'])

const SENSITIVE_PATH_PARTS = new Set([
  '.emperor',
  '.git',
  '.team',
  'memory',
  'node_modules',
])
const SENSITIVE_PATH_PREFIXES = ['desktop/out', 'desktop/dist']
const SENSITIVE_FILENAMES = new Set(['.env', 'model_config.json'])

interface ParsedCommand {
  segments: string[][]
  hasControlOperator: boolean
  hasRedirection: boolean
  unsupported: boolean
}

function safeCommandParts(command: string): string[] | null {
  const parsed = parseShellCommand(command)
  if (parsed.unsupported || parsed.hasControlOperator || parsed.hasRedirection)
    return null
  if (parsed.segments.length !== 1) return null
  const parts = parsed.segments[0] ?? []
  return parts.length ? parts : null
}

export function isHighRiskCommand(command: string): boolean {
  const parsed = parseShellCommand(command)
  if (parsed.unsupported) return HIGH_RISK_FALLBACK.test(command || '')
  return parsed.segments.some((segment) => isHighRiskSegment(segment))
}

export function isLowRiskCommand(command: string): boolean {
  return isReadonlyCommand(command)
}

/** Commands whose runner loads code controlled by the current project. */
export function executesProjectCodeCommand(command: string): boolean {
  const parts = safeCommandParts(command)
  if (!parts) return false
  const head = basename(parts[0] ?? '')
  if (head === 'pytest') return true
  if (head === 'python' || head === 'python3') {
    const moduleIndex = parts.indexOf('-m', 1)
    if (moduleIndex >= 1 && parts[moduleIndex + 1] === 'pytest') return true
  }
  if (head === 'npm') {
    const args = parts.slice(1)
    return args.includes('test') || args.includes('run')
  }
  return false
}

export function isReadonlyCommand(command: string): boolean {
  const parts = safeCommandParts(command)
  if (!parts) return false
  const head = (parts[0] ?? '').split('/').pop()!
  if (READONLY_SINGLE.has(head)) return true
  return head === 'git' && parts.length >= 2 && READONLY_GIT_SUB.has(parts[1]!)
}

export function isSensitivePath(path: string | null | undefined): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/g, '/').trim()
  const parts = normalized.split('/')
  if (parts.some((p) => SENSITIVE_PATH_PARTS.has(p))) return true
  if (
    SENSITIVE_PATH_PREFIXES.some(
      (p) => normalized === p || normalized.startsWith(`${p}/`),
    )
  )
    return true
  if (normalized.startsWith('../') || normalized.includes('/../')) return true
  const name = parts[parts.length - 1] ?? ''
  return SENSITIVE_FILENAMES.has(name) || name.endsWith('.local.md')
}

export function schedulerAction(args: Record<string, unknown>): string {
  return String(args.action ?? '')
    .trim()
    .toLowerCase()
}

function parseShellCommand(command: string): ParsedCommand {
  const tokens = tokenizeShell(command)
  const segments: string[][] = []
  let current: string[] = []
  let hasControlOperator = false
  let hasRedirection = false
  for (const token of tokens.tokens) {
    if (token.kind === 'control') {
      hasControlOperator = true
      if (current.length) segments.push(current)
      current = []
      continue
    }
    if (token.kind === 'redirection') {
      hasRedirection = true
      continue
    }
    current.push(token.value)
  }
  if (current.length) segments.push(current)
  return {
    segments,
    hasControlOperator,
    hasRedirection,
    unsupported: tokens.unsupported,
  }
}

function tokenizeShell(command: string): {
  tokens: Array<{ kind: 'word' | 'control' | 'redirection'; value: string }>
  unsupported: boolean
} {
  const input = String(command || '').trim()
  const tokens: Array<{
    kind: 'word' | 'control' | 'redirection'
    value: string
  }> = []
  let unsupported = false
  let word = ''
  const flushWord = (): void => {
    if (!word) return
    tokens.push({ kind: 'word', value: word })
    word = ''
  }
  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!
    if (/\s/.test(ch)) {
      flushWord()
      if (ch === '\n') tokens.push({ kind: 'control', value: '\n' })
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let closed = false
      for (index += 1; index < input.length; index++) {
        const qch = input[index]!
        if (qch === quote) {
          closed = true
          break
        }
        if (qch === '\\' || qch === '`' || qch === '$') unsupported = true
        word += qch
      }
      if (!closed) unsupported = true
      continue
    }
    const two = input.slice(index, index + 2)
    if (two === '&&' || two === '||' || two === '>>' || two === '<<') {
      flushWord()
      tokens.push({
        kind: two === '&&' || two === '||' ? 'control' : 'redirection',
        value: two,
      })
      index += 1
      continue
    }
    if (ch === ';' || ch === '|') {
      flushWord()
      tokens.push({ kind: 'control', value: ch })
      continue
    }
    if (ch === '>' || ch === '<') {
      flushWord()
      tokens.push({ kind: 'redirection', value: ch })
      continue
    }
    if (
      ch === '`' ||
      ch === '$' ||
      ch === '(' ||
      ch === ')' ||
      ch === '{' ||
      ch === '}' ||
      ch === '\\'
    ) {
      unsupported = true
    }
    word += ch
  }
  flushWord()
  return { tokens, unsupported }
}

function isHighRiskSegment(segment: string[]): boolean {
  if (!segment.length) return false
  const parts = segment.map((part) => part.trim()).filter(Boolean)
  const head = basename(parts[0] ?? '')
  const sub = parts[1] ?? ''
  if (parts.some((part) => basename(part) === 'sudo')) return true
  if (head === 'git' && sub === 'push') return true
  if (
    head === 'gh' &&
    (sub === 'release' ||
      sub === 'workflow' ||
      sub === 'run' ||
      (sub === 'pr' && parts[2] === 'merge'))
  )
    return true
  if (
    head === 'rm' &&
    parts
      .slice(1)
      .some(
        (part) =>
          part === '--recursive' ||
          part === '--force' ||
          /^-[A-Za-z]*[rf][A-Za-z]*$/.test(part),
      )
  )
    return true
  if (head === 'chmod' || head === 'chown' || head === 'kubectl') return true
  if (head === 'deploy' || head === 'publish' || head === 'release') return true
  if (head === 'npm' && (sub === 'install' || sub === 'publish')) return true
  if (head === 'pip' && sub === 'install') return true
  if (head === 'brew' && sub === 'install') return true
  if (
    head === 'docker' &&
    (sub === 'push' ||
      sub === 'run' ||
      (sub === 'compose' && parts[2] === 'up'))
  )
    return true
  if (head === 'terraform' && (sub === 'apply' || sub === 'destroy'))
    return true
  return false
}

function basename(value: string): string {
  return value.split('/').pop() || value
}
