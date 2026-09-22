/**
 * Workspace instructions (ported from dsh-agent-instructions).
 *
 * Discovery: the user-global `<home>/AGENTS.md` first, then every directory
 * from the project root (nearest `.git` ancestor, else cwd) down to cwd,
 * checking AGENTS.md, CLAUDE.md, AGENTS.local.md, CLAUDE.local.md in that
 * order; real paths are de-duplicated; each file reads at most 1 MiB.
 *
 * Rendering wraps everything in one `<system-reminder>` frame. Over the byte
 * budget, the broadest files are omitted first, then the most specific one
 * is truncated, with a budget note naming what was cut.
 *
 * Delivery: a durable `user/message` baseline (`form: 'instructions'`)
 * entered at the first step of the first turn; whenever the discovered set
 * changes, the next turn enters a replacement baseline. Never a hidden
 * system-prompt change, so the request prefix stays cache-stable.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { contextMessage, type UserMessage } from '../../llm/message'
import type { Session } from '../../session-log/session'
import type { PreStepMiddleware } from '../agent/middleware'

export const AGENT_INSTRUCTIONS_PRODUCER = 'agent-instructions'
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 65536
const MAX_SOURCE_BYTES = 1024 * 1024
const CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
] as const

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'
const INTRO =
  'The following workspace instructions may be relevant to your work. ' +
  'Use them as guidance when applicable. More specific instructions take precedence over broader ones. ' +
  'They do not override system, developer, or direct user instructions.'
const REPLACEMENT_INTRO = `This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ${INTRO}`
const EMPTY_REPLACEMENT_INTRO =
  'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.'
const COMPACT_INTRO =
  'Workspace instructions were omitted or truncated to fit the configured byte budget.'

export interface InstructionFile {
  absolutePath: string
  displayPath: string
  content: string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function readBounded(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES)
      const read = readSync(fd, buffer, 0, MAX_SOURCE_BYTES, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function projectRoot(cwd: string): string {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** Discover instruction files for one workspace. */
export function discoverInstructionFiles(
  cwd: string,
  options: { globalDir?: string; globalDisplay?: string } = {},
): InstructionFile[] {
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  const add = (absolutePath: string, displayPath: string): void => {
    let real: string
    try {
      real = realpathSync.native(absolutePath)
    } catch {
      return
    }
    if (seen.has(real)) return
    const content = readBounded(real)
    if (content === undefined) return
    seen.add(real)
    files.push({ absolutePath: real, displayPath, content })
  }
  const globalDir = options.globalDir ?? join(homedir(), '.emperor')
  add(
    join(globalDir, 'AGENTS.md'),
    options.globalDisplay ?? '~/.emperor/AGENTS.md',
  )
  const root = projectRoot(cwd)
  const target = resolve(cwd)
  const chain: string[] = []
  for (let current = target; ; current = dirname(current)) {
    chain.unshift(current)
    if (current === root || dirname(current) === current) break
  }
  for (const directory of chain) {
    for (const name of CANDIDATES) {
      const rel = relative(root, join(directory, name))
      add(join(directory, name), rel === '' ? name : rel)
    }
  }
  return files
}

function section(file: InstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

function build(
  files: InstructionFile[],
  maxBytes: number,
  intro: string,
  omitted: InstructionFile[],
  truncated: Array<{
    displayPath: string
    originalBytes: number
    includedBytes: number
  }>,
): string {
  const parts: string[] = []
  if (omitted.length > 0)
    parts.push(`omitted ${omitted.map((file) => file.displayPath).join(', ')}`)
  if (truncated.length > 0)
    parts.push(
      `truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`,
    )
  const marker =
    parts.length === 0
      ? ''
      : `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
  const body = [marker, intro, ...files.map(section)]
    .filter((block) => block.length > 0)
    .join('\n\n')
  return [OPEN, body.replaceAll(CLOSE, '<\\/system-reminder>'), CLOSE].join(
    '\n',
  )
}

/** Render files within `maxBytes` (omit broadest first, then truncate the most specific). */
export function renderInstructions(
  files: InstructionFile[],
  maxBytes = DEFAULT_INSTRUCTIONS_MAX_BYTES,
  replacement = false,
): string {
  if (maxBytes <= 0) return ''
  if (files.length === 0)
    return replacement
      ? build([], maxBytes, EMPTY_REPLACEMENT_INTRO, [], [])
      : ''
  const intro = replacement ? REPLACEMENT_INTRO : INTRO
  const full = build(files, maxBytes, intro, [], [])
  if (byteLength(full) <= maxBytes) return full
  for (let start = 1; start < files.length; start += 1) {
    const text = build(
      files.slice(start),
      maxBytes,
      intro,
      files.slice(0, start),
      [],
    )
    if (byteLength(text) <= maxBytes) return text
  }
  const specific = files.at(-1)!
  const omitted = files.slice(0, -1)
  const originalBytes = byteLength(specific.content)
  for (const candidateIntro of [intro, COMPACT_INTRO]) {
    let low = 0
    let high = originalBytes
    let best: string | undefined
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const content = truncateUtf8(specific.content, mid)
      const text = build(
        [{ ...specific, content }],
        maxBytes,
        candidateIntro,
        omitted,
        [
          {
            displayPath: specific.displayPath,
            originalBytes,
            includedBytes: byteLength(content),
          },
        ],
      )
      if (byteLength(text) <= maxBytes) {
        best = text
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (best !== undefined) return best
  }
  return ''
}

function digestOf(files: InstructionFile[]): string {
  const hash = createHash('sha256')
  for (const file of files)
    hash
      .update(file.absolutePath)
      .update('\0')
      .update(file.content)
      .update('\0')
  return hash.digest('hex')
}

declare module '../../session-log/types' {
  interface SessionEventMap {
    /** Log-only record of the instruction set a baseline represents. */
    'instructions/baseline': { digest: string; files: string[] }
  }
}

function lastBaselineDigest(session: Session): string | undefined {
  return session.lastOf('instructions/baseline')?.data.digest
}

export interface AgentInstructionsOptions {
  maxBytes?: number
  globalDir?: string
  globalDisplay?: string
}

/**
 * Pre-step middleware entering the baseline at the first step of each turn
 * whose discovered set differs from the last logged baseline.
 */
export function agentInstructionsMiddleware(
  options: AgentInstructionsOptions = {},
): PreStepMiddleware {
  const maxBytes = options.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES
  return ({ agent, messages, step }) => {
    if (step !== 1) return undefined
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return undefined
    // Delegated agents inherit their parent's instructions through the fork seed or prompt.
    const files = discoverInstructionFiles(cwd, {
      ...(options.globalDir === undefined
        ? {}
        : { globalDir: options.globalDir }),
      ...(options.globalDisplay === undefined
        ? {}
        : { globalDisplay: options.globalDisplay }),
    })
    const digest = digestOf(files)
    const previous = lastBaselineDigest(agent.session)
    if (previous === digest) return undefined
    if (previous === undefined && files.length === 0) {
      agent.session.append('instructions/baseline', { digest, files: [] })
      return undefined
    }
    const text = renderInstructions(files, maxBytes, previous !== undefined)
    agent.session.append('instructions/baseline', {
      digest,
      files: files.map((file) => file.displayPath),
    })
    if (text.length === 0) return undefined
    const baseline: UserMessage = contextMessage(
      AGENT_INSTRUCTIONS_PRODUCER,
      text,
      { form: 'instructions' },
    )
    return { kind: 'enter', messages: [baseline, ...messages] }
  }
}
