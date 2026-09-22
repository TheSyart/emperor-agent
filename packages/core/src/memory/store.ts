/**
 * MemoryStore — durable memory files kept across sessions: long-term memory
 * (MEMORY.local.md), daily episodes (UTC+8 calendar day), the user profile and
 * their version snapshots.
 *
 * Per-session conversation history, turn checkpoints and compact markers are
 * retired with the old kernel: the harness session log is the only trajectory.
 * Legacy `history.jsonl` / `_checkpoint.json` files left on disk are neither
 * read nor created.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { MemoryVersionStore } from './versions'
import { todayUtc8 } from './time-utc8'

export class MemoryStore {
  readonly memoryDir: string
  readonly memoryFile: string
  readonly userFile: string
  readonly memoryTemplate: string | null
  readonly versions: MemoryVersionStore

  constructor(
    memoryDir: string,
    userFile: string,
    opts?: { memoryTemplate?: string | null },
  ) {
    this.memoryDir = memoryDir
    this.memoryFile = join(memoryDir, 'MEMORY.local.md')
    this.userFile = userFile
    this.memoryTemplate = opts?.memoryTemplate ?? null
    this.ensure()
    this.versions = new MemoryVersionStore(
      join(this.memoryDir, '..'),
      this.memoryDir,
      this.userFile,
    )
  }

  private ensure(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    const legacyMemory = join(this.memoryDir, 'MEMORY.md')
    if (!existsSync(this.memoryFile) && existsSync(legacyMemory))
      renameSync(legacyMemory, this.memoryFile)
    if (!existsSync(this.memoryFile)) {
      if (this.memoryTemplate && existsSync(this.memoryTemplate)) {
        writeFileSync(
          this.memoryFile,
          readFileSync(this.memoryTemplate, 'utf8'),
          'utf8',
        )
      } else {
        writeFileSync(
          this.memoryFile,
          '# 长期记忆\n\n此文件常驻上下文，记录核心目标、当前任务与关键事实。\n',
          'utf8',
        )
      }
    }
  }

  // ── 中期层（按日历日 UTC+8）──
  todayEpisodePath(): string {
    return join(this.memoryDir, `${todayUtc8()}.md`)
  }

  readTodayEpisode(): string {
    const p = this.todayEpisodePath()
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  appendEpisode(content: string): void {
    const p = this.todayEpisodePath()
    const stem = todayUtc8()
    const existing = existsSync(p)
      ? readFileSync(p, 'utf8')
      : `# ${stem} 情景记忆\n`
    if (existsSync(p))
      this.versions.snapshotPath(p, {
        target: 'episode',
        reason: 'append_episode',
      })
    const newText =
      existing.replace(/\s+$/, '') + '\n\n' + content.trim() + '\n'
    writeFileSync(p, newText, 'utf8')
  }

  // ── 长期层 ──
  readMemory(): string {
    return existsSync(this.memoryFile)
      ? readFileSync(this.memoryFile, 'utf8')
      : ''
  }

  writeMemory(content: string): void {
    if (existsSync(this.memoryFile))
      this.versions.snapshotPath(this.memoryFile, {
        target: 'memory',
        reason: 'write_memory',
      })
    MemoryVersionStore.atomicWriteText(this.memoryFile, content.trim() + '\n')
  }

  // ── 用户偏好 ──
  readUser(): string {
    return existsSync(this.userFile) ? readFileSync(this.userFile, 'utf8') : ''
  }

  writeUser(content: string): void {
    if (existsSync(this.userFile))
      this.versions.snapshotPath(this.userFile, {
        target: 'user',
        reason: 'write_user',
      })
    MemoryVersionStore.atomicWriteText(this.userFile, content.trim() + '\n')
  }
}
