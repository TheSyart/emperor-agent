import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class SidechainTranscript {
  readonly root: string
  readonly taskId: string
  readonly path: string

  constructor(root: string, taskId: string) {
    this.root = root
    this.taskId = String(taskId)
    this.path = join(root, 'tasks', this.taskId, 'transcript.jsonl')
  }

  append(message: Record<string, unknown>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = {
      ...message,
      task_id: message.task_id ?? this.taskId,
      sidechain: message.sidechain ?? true,
      ts: message.ts ?? Date.now() / 1000,
    }
    appendFileSync(this.path, JSON.stringify(payload) + '\n', 'utf8')
  }

  extend(messages: Array<Record<string, unknown>>): void {
    for (const message of messages) this.append(message)
  }

  read(opts: { offset?: number; limit?: number } = {}): { messages: Array<Record<string, any>>; nextOffset: number; path: string } {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
    const limit = Math.max(0, Math.trunc(opts.limit ?? 100))
    const messages: Array<Record<string, any>> = []
    let nextOffset = 0
    if (!existsSync(this.path)) return { messages: [], nextOffset: 0, path: this.path }
    const lines = readFileSync(this.path, 'utf8').split('\n')
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber]
      if (!line) continue
      nextOffset = lineNumber + 1
      if (lineNumber < offset) continue
      if (messages.length >= limit) break
      try {
        const payload = JSON.parse(line)
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) messages.push(payload)
      } catch {
        continue
      }
    }
    return { messages, nextOffset: Math.min(nextOffset, offset + messages.length), path: this.path }
  }
}
