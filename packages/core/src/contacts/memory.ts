import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryStore } from '../memory/store'
import { charCount } from './validate'
import {
  ContactMemoryEntryNotFoundError,
  ContactValidationError,
} from './errors'

/** What of a contact's memory goes into its prompt: the newest lines that fit. */
export const MEMORY_PROMPT_BYTES = 4 * 1024
/** One entry (a line of memory), as the user writes or edits it. */
export const MEMORY_ENTRY_CHARS = 500

const HEADER = '# 个人记忆'
const ENTRY_LINE = /^- (.*)$/
const FEEDBACK_LINE = /^(\d{4}-\d{2}-\d{2}) · (👍|👎) · /u

export interface ContactMemoryEntry {
  /** Stable while the text stays the same (a hash of it). */
  id: string
  text: string
  /** Set on a feedback line (`YYYY-MM-DD · 👍 · …`). */
  date?: string
  rating?: 'up' | 'down'
}

export interface ContactMemoryListing {
  contactId: string
  /** The contact's memory switch: off, nothing goes into its prompt. */
  enabled: boolean
  entries: ContactMemoryEntry[]
  /** Size of the entries on disk (UTF-8 bytes). */
  bytes: number
  /** What the prompt takes ({@link MEMORY_PROMPT_BYTES}). */
  limit: number
  /** The prompt has only the newest entries. */
  truncated: boolean
  /** Set when truncated: asks the user to tidy the memory up. */
  notice: string | null
}

export interface FeedbackLineInput {
  /** `YYYY-MM-DD`. */
  date: string
  rating: 'up' | 'down'
  /** The user's own words, kept as they wrote them (on one line). */
  note?: string
  /** Where it was said, e.g. 单聊「改稿」. */
  source: string
  /** The start of the reply the feedback is about. */
  excerpt?: string
}

/** Text on one line: line breaks and runs of blank space become one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * One piece of explicit feedback as a line of memory: date, rating, the
 * user's words and where they said it.
 */
export function feedbackLine(input: FeedbackLineInput): string {
  const note = oneLine(input.note ?? '')
  const excerpt = oneLine(input.excerpt ?? '')
  return [
    input.date,
    input.rating === 'up' ? '👍' : '👎',
    note ? `「${note}」` : '（没写原因）',
    `来源：${oneLine(input.source)}${excerpt ? `里的回答「${excerpt}」` : ''}`,
  ].join(' · ')
}

function entryId(text: string): string {
  return `m-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
}

function toEntry(text: string): ContactMemoryEntry {
  const feedback = FEEDBACK_LINE.exec(text)
  return {
    id: entryId(text),
    text,
    ...(feedback
      ? { date: feedback[1]!, rating: feedback[2] === '👍' ? 'up' : 'down' }
      : {}),
  }
}

/** An entry's text: trimmed, one line, 1–500 characters. */
function entryText(value: unknown): string {
  if (typeof value !== 'string')
    throw new ContactValidationError('memory', '记忆必须是文字')
  const text = value.trim()
  if (!text) throw new ContactValidationError('memory', '记忆不能为空')
  if (/[\r\n]/.test(text))
    throw new ContactValidationError('memory', '一条记忆只写一行')
  if (charCount(text) > MEMORY_ENTRY_CHARS)
    throw new ContactValidationError(
      'memory',
      `一条记忆最多 ${MEMORY_ENTRY_CHARS} 字（现在 ${charCount(text)} 字）`,
    )
  return text
}

/**
 * Contacts' personal memory (GRP-03): `<stateRoot>/contacts/<id>/memory/`
 * through {@link MemoryStore}, so `MEMORY.local.md` keeps its versions. One
 * line per explicit piece of feedback from the user — nothing is distilled
 * from conversations on the side. Every entry can be changed or deleted;
 * the prompt takes the newest {@link MEMORY_PROMPT_BYTES}. Nothing is
 * created until the first entry. Deleting a contact removes its folder.
 */
export class ContactMemoryStore {
  private readonly root: string

  constructor(stateRoot: string) {
    this.root = join(resolve(stateRoot), 'contacts')
  }

  dir(contactId: string): string {
    return join(this.root, contactId, 'memory')
  }

  file(contactId: string): string {
    return join(this.dir(contactId), 'MEMORY.local.md')
  }

  entries(contactId: string): ContactMemoryEntry[] {
    return this.lines(contactId)
      .map((line) => ENTRY_LINE.exec(line)?.[1]?.trim())
      .filter((text): text is string => !!text)
      .map(toEntry)
  }

  /** The newest entries within {@link MEMORY_PROMPT_BYTES}, whole lines only. */
  promptText(contactId: string): { text: string; truncated: boolean } {
    const lines = this.entries(contactId).map((entry) => `- ${entry.text}`)
    const kept: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const size = Buffer.byteLength(lines[index]!) + (kept.length ? 1 : 0)
      if (bytes + size > MEMORY_PROMPT_BYTES) break
      kept.unshift(lines[index]!)
      bytes += size
    }
    return { text: kept.join('\n'), truncated: kept.length < lines.length }
  }

  listing(contactId: string, enabled: boolean): ContactMemoryListing {
    const entries = this.entries(contactId)
    const { truncated } = this.promptText(contactId)
    return {
      contactId,
      enabled,
      entries,
      bytes: entries.reduce(
        (sum, entry, index) =>
          sum + Buffer.byteLength(`- ${entry.text}`) + (index ? 1 : 0),
        0,
      ),
      limit: MEMORY_PROMPT_BYTES,
      truncated,
      notice: truncated
        ? `记忆超过 ${MEMORY_PROMPT_BYTES / 1024} KB，提示词里只放了最新的部分；请删掉或合并旧的条目，整理一下`
        : null,
    }
  }

  append(contactId: string, text: string): ContactMemoryEntry {
    const line = entryText(text)
    const lines = this.lines(contactId)
    this.write(contactId, [...lines, `- ${line}`])
    return toEntry(line)
  }

  update(contactId: string, id: string, text: string): ContactMemoryEntry {
    const line = entryText(text)
    const lines = this.lines(contactId)
    const index = this.indexOf(lines, id)
    lines[index] = `- ${line}`
    this.write(contactId, lines)
    return toEntry(line)
  }

  delete(contactId: string, id: string): void {
    const lines = this.lines(contactId)
    lines.splice(this.indexOf(lines, id), 1)
    this.write(contactId, lines)
  }

  /** The file's lines after the header (none when there is no file). */
  private lines(contactId: string): string[] {
    const path = this.file(contactId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')
    if (lines[0]?.trim() === HEADER) lines.shift()
    while (lines.length && !lines[0]!.trim()) lines.shift()
    while (lines.length && !lines.at(-1)!.trim()) lines.pop()
    return lines
  }

  private indexOf(lines: readonly string[], id: string): number {
    const index = lines.findIndex((line) => {
      const text = ENTRY_LINE.exec(line)?.[1]?.trim()
      return text !== undefined && entryId(text) === id
    })
    if (index < 0) throw new ContactMemoryEntryNotFoundError(id)
    return index
  }

  private write(contactId: string, lines: readonly string[]): void {
    const dir = this.dir(contactId)
    if (!existsSync(this.file(contactId))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(this.file(contactId), `${HEADER}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    }
    // MemoryStore snapshots the old contents before it replaces them.
    const store = new MemoryStore(dir, join(dir, 'USER.local.md'))
    store.writeMemory(
      lines.length ? `${HEADER}\n\n${lines.join('\n')}` : HEADER,
    )
  }
}
