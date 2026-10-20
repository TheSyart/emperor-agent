import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { LOG_FILE } from '../session-log/store'

/**
 * Session content search for the command palette (UI-S02): the newest
 * sessions first, one hit per session — the first message that contains the
 * query, from the user's own messages and the model's replies (tool output,
 * injected context and other runtime text are not searched). Logs are read
 * line by line; a line that does not contain the query as raw text is not
 * parsed, and a line that cannot be parsed is skipped. Logs over
 * MAX_LOG_BYTES are skipped (title search still finds them).
 */
export interface SessionSearchHit {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  /** The match with some context, cut to about SNIPPET_CHARS. */
  snippet: string
}

export interface SessionSearchInput {
  /** The sessions root (`<root>/<id>/log.jsonl`). */
  root: string
  /** Indexed sessions to search, any order; newest are read first. */
  sessions: ReadonlyArray<{ id: string; title: string; updated_at?: string }>
  query: string
  limit?: number
}

const DEFAULT_LIMIT = 20
const MAX_SESSIONS = 300
const MAX_LOG_BYTES = 32 * 1024 * 1024
const SNIPPET_CHARS = 80

export async function searchSessionLogs(
  input: SessionSearchInput,
): Promise<SessionSearchHit[]> {
  const needle = input.query.trim().toLowerCase()
  if (!needle) return []
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 50))
  const ordered = [...input.sessions]
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, MAX_SESSIONS)
  const hits: SessionSearchHit[] = []
  for (const session of ordered) {
    if (hits.length >= limit) break
    const match = await firstMatch(
      join(input.root, session.id, LOG_FILE),
      needle,
    )
    if (match)
      hits.push({ sessionId: session.id, title: session.title, ...match })
  }
  return hits
}

async function firstMatch(
  path: string,
  needle: string,
): Promise<Pick<SessionSearchHit, 'role' | 'snippet'> | null> {
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size > MAX_LOG_BYTES) return null
  } catch {
    return null
  }
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of lines) {
      if (!line.toLowerCase().includes(needle)) continue
      const found = messageText(line)
      if (!found) continue
      if (!found.text.toLowerCase().includes(needle)) continue
      return { role: found.role, snippet: snippet(found.text, needle) }
    }
  } catch {
    return null
  } finally {
    lines.close()
  }
  return null
}

/** The searchable text of one log line, or null. */
function messageText(
  line: string,
): { role: 'user' | 'assistant'; text: string } | null {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (!event || typeof event !== 'object') return null
  const { type, data } = event as { type?: unknown; data?: unknown }
  if (type === 'user/message') {
    const message = data as { source?: { kind?: unknown }; content?: unknown }
    if (message?.source?.kind !== 'user') return null
    return { role: 'user', text: textOf(message.content) }
  }
  if (type === 'assistant/message') {
    const message = (data as { message?: { content?: unknown } })?.message
    return { role: 'assistant', text: textOf(message?.content) }
  }
  return null
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && block.type === 'text'
        ? String(block.text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_CHARS) return flat
  const at = Math.max(
    0,
    flat.toLowerCase().indexOf(needle.replace(/\s+/g, ' ')),
  )
  const start = Math.max(
    0,
    at - Math.floor((SNIPPET_CHARS - needle.length) / 3),
  )
  const end = Math.min(flat.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
