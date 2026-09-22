/**
 * Minimal ANSI SGR parser for TerminalBlock: basic 8/16 foreground colors,
 * bold/dim/italic/underline. Everything else (OSC, cursor movement, 256-color
 * and truecolor parameters, backgrounds) is dropped so only visible text and
 * token-mapped colors survive. Carriage returns keep the last overwrite.
 */
export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'

export interface AnsiSpan {
  text: string
  color?: AnsiColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export type AnsiLine = AnsiSpan[]

const BASIC: AnsiColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
]

interface SgrState {
  color?: AnsiColor
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function applySgr(state: SgrState, params: number[]): SgrState {
  const next: SgrState = { ...state }
  for (let i = 0; i < params.length; i++) {
    const code = params[i]
    if (code === 0) {
      delete next.color
      delete next.bold
      delete next.dim
      delete next.italic
      delete next.underline
    } else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) {
      delete next.bold
      delete next.dim
    } else if (code === 23) delete next.italic
    else if (code === 24) delete next.underline
    else if (code >= 30 && code <= 37) next.color = BASIC[code - 30]
    else if (code === 39) delete next.color
    else if (code === 90) next.color = 'gray'
    else if (code >= 91 && code <= 97) next.color = BASIC[code - 90]
    else if (code === 38 || code === 48) {
      // Skip extended color payloads (`38;5;N` / `38;2;R;G;B`).
      i += params[i + 1] === 5 ? 2 : params[i + 1] === 2 ? 4 : 0
    }
  }
  return next
}

const ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Parse text with ANSI escapes into lines of styled spans. */
export function parseAnsiLines(text: string): AnsiLine[] {
  const lines: AnsiLine[] = []
  let state: SgrState = {}
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.includes('\r')
      ? rawLine.slice(rawLine.lastIndexOf('\r') + 1)
      : rawLine
    const spans: AnsiSpan[] = []
    let last = 0
    const push = (chunk: string) => {
      const clean = chunk.replace(CONTROL, '')
      if (clean) spans.push({ text: clean, ...state })
    }
    for (const match of line.matchAll(ESCAPE)) {
      push(line.slice(last, match.index))
      last = (match.index ?? 0) + match[0].length
      if (match[2] === 'm') {
        const params = (match[1] || '0')
          .split(';')
          .map((part) => Number(part || 0))
        state = applySgr(state, params)
      }
    }
    push(line.slice(last))
    lines.push(spans)
  }
  return lines
}

/** CSS classes for one span (token-mapped in TerminalBlock's scoped style). */
export function ansiClasses(span: AnsiSpan): string[] {
  const out: string[] = []
  if (span.color) out.push(`ansi-${span.color}`)
  if (span.bold) out.push('ansi-bold')
  if (span.dim) out.push('ansi-dim')
  if (span.italic) out.push('ansi-italic')
  if (span.underline) out.push('ansi-underline')
  return out
}
