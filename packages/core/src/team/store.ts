import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LEAD_ACTOR,
  TeamMember,
  TeamStatus,
  TEAM_SCHEMA_VERSION,
  validateActorName,
  validateMemberName,
  type TeamMemberPayload,
} from './models'

export interface TeamConfigPayload {
  version?: number
  team_name: string
  members: TeamMemberPayload[]
  [key: string]: unknown
}

export class TeamStore {
  readonly root: string
  readonly teamDir: string
  readonly configFile: string
  readonly inboxDir: string
  readonly threadsDir: string
  readonly checkpointsDir: string
  readonly cursorsDir: string

  constructor(root: string, opts: { teamDir?: string | null } = {}) {
    this.root = root
    this.teamDir = opts.teamDir ?? join(root, '.team')
    this.configFile = join(this.teamDir, 'config.json')
    this.inboxDir = join(this.teamDir, 'inbox')
    this.threadsDir = join(this.teamDir, 'threads')
    this.checkpointsDir = join(this.teamDir, 'checkpoints')
    this.cursorsDir = join(this.teamDir, 'cursors')
    this.ensure()
    this.markStaleWorkingOffline()
  }

  loadConfig(): TeamConfigPayload {
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8') || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        raw = parsed
    } catch {
      // 审计 P1-5：损坏文件先隔离备份再回退默认，不能静默丢弃——否则下一次
      // saveConfig() 会直接用空花名册覆盖掉这份证据，永久抹掉队友配置。
      if (existsSync(this.configFile)) {
        const backup = join(
          this.teamDir,
          `config.json.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        )
        try {
          renameSync(this.configFile, backup)
        } catch {
          /* ignore */
        }
      }
    }
    const members: TeamMemberPayload[] = []
    for (const item of Array.isArray(raw.members) ? raw.members : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      try {
        members.push(
          TeamMember.fromDict(item as Record<string, unknown>).toDict(),
        )
      } catch {}
    }
    return {
      version: Number(raw.version ?? TEAM_SCHEMA_VERSION),
      team_name: String(raw.team_name ?? raw.teamName ?? 'default'),
      members,
    }
  }

  saveConfig(config: Record<string, unknown>): void {
    atomicWriteJson(this.configFile, {
      version: Number(config.version ?? TEAM_SCHEMA_VERSION),
      team_name: String(config.team_name ?? 'default'),
      members: Array.isArray(config.members) ? config.members : [],
    })
  }

  listMembers(): TeamMember[] {
    return (
      (this.loadConfig().members as Array<Record<string, unknown>>) ?? []
    ).map((item) => TeamMember.fromDict(item))
  }

  getMember(name: string): TeamMember | null {
    const safe = validateMemberName(name)
    return this.listMembers().find((member) => member.name === safe) ?? null
  }

  upsertMember(member: TeamMember): TeamMember {
    const config = this.loadConfig()
    const members: TeamMemberPayload[] = []
    let replaced = false
    for (const item of config.members) {
      const current = TeamMember.fromDict(item)
      if (current.name === member.name) {
        members.push(member.toDict())
        replaced = true
      } else {
        members.push(current.toDict())
      }
    }
    if (!replaced) members.push(member.toDict())
    config.members = members
    this.saveConfig(config)
    return member
  }

  updateMember(
    name: string,
    fields: Partial<Record<keyof TeamMember, unknown>>,
  ): TeamMember {
    const member = this.getMember(name)
    if (!member) throw new Error(`unknown teammate: ${name}`)
    const updated = TeamMember.fromDict({ ...member.toDict(), ...fields })
    return this.upsertMember(updated)
  }

  markStaleWorkingOffline(): void {
    const members = this.listMembers()
    let changed = false
    const out = members.map((member) => {
      if (member.status === TeamStatus.WORKING) {
        changed = true
        return member
          .touch({ status: TeamStatus.OFFLINE, last_error: null })
          .toDict()
      }
      return member.toDict()
    })
    if (changed) {
      const config = this.loadConfig()
      config.members = out
      this.saveConfig(config)
    }
  }

  inboxPath(actor: string): string {
    return join(this.inboxDir, `${validateActorName(actor)}.jsonl`)
  }
  threadPath(name: string): string {
    return join(this.threadsDir, `${validateMemberName(name)}.json`)
  }
  checkpointPath(name: string): string {
    return join(this.checkpointsDir, `${validateMemberName(name)}.json`)
  }
  cursorPath(actor: string): string {
    return join(this.cursorsDir, `${validateActorName(actor)}.json`)
  }

  readThread(name: string): Array<Record<string, unknown>> {
    const path = this.threadPath(name)
    if (!existsSync(path)) return []
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      return raw && typeof raw === 'object' && Array.isArray(raw.messages)
        ? raw.messages
        : []
    } catch {
      return []
    }
  }

  writeThread(name: string, messages: Array<Record<string, unknown>>): void {
    atomicWriteJson(this.threadPath(name), {
      version: TEAM_SCHEMA_VERSION,
      member: validateMemberName(name),
      messages,
    })
  }

  readCheckpointPayload(name: string): Record<string, unknown> | null {
    const path = this.checkpointPath(name)
    if (!existsSync(path)) return null
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    } catch {
      return null
    }
    const payload = Array.isArray(raw)
      ? { messages: raw }
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null
    if (!payload || !Array.isArray(payload.messages)) return null
    return {
      version: Number(payload.version ?? TEAM_SCHEMA_VERSION),
      member: validateMemberName(name),
      messages: payload.messages,
      pending_cursor_start:
        payload.pending_cursor_start === undefined
          ? undefined
          : Math.max(0, Number(payload.pending_cursor_start)),
      pending_cursor_end:
        payload.pending_cursor_end === undefined
          ? undefined
          : Math.max(0, Number(payload.pending_cursor_end)),
      pending_message_ids: Array.isArray(payload.pending_message_ids)
        ? payload.pending_message_ids.map(String)
        : undefined,
    }
  }

  readCheckpoint(name: string): Array<Record<string, unknown>> | null {
    const payload = this.readCheckpointPayload(name)
    return Array.isArray(payload?.messages)
      ? (payload.messages as Array<Record<string, unknown>>)
      : null
  }

  writeCheckpoint(
    name: string,
    messages: Array<Record<string, unknown>>,
    opts: {
      pending_cursor_start?: number | null
      pending_cursor_end?: number | null
      pending_message_ids?: string[] | null
    } = {},
  ): void {
    const payload: Record<string, unknown> = {
      version: TEAM_SCHEMA_VERSION,
      member: validateMemberName(name),
      messages,
    }
    if (
      opts.pending_cursor_start !== undefined &&
      opts.pending_cursor_start !== null
    )
      payload.pending_cursor_start = Math.max(0, opts.pending_cursor_start)
    if (
      opts.pending_cursor_end !== undefined &&
      opts.pending_cursor_end !== null
    )
      payload.pending_cursor_end = Math.max(0, opts.pending_cursor_end)
    if (opts.pending_message_ids)
      payload.pending_message_ids = opts.pending_message_ids.map(String)
    atomicWriteJson(this.checkpointPath(name), payload)
  }

  clearCheckpoint(name: string): void {
    try {
      unlinkSync(this.checkpointPath(name))
    } catch {}
  }

  readCursor(actor: string): number {
    const path = this.cursorPath(actor)
    if (!existsSync(path)) return 0
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
      return Math.max(0, Number(raw.inbox ?? 0))
    } catch {
      return 0
    }
  }

  writeCursor(actor: string, offset: number): void {
    atomicWriteJson(this.cursorPath(actor), {
      inbox: Math.max(0, Math.floor(offset)),
    })
  }

  private ensure(): void {
    for (const path of [
      this.teamDir,
      this.inboxDir,
      this.threadsDir,
      this.checkpointsDir,
      this.cursorsDir,
    ])
      mkdirSync(path, { recursive: true })
    if (!existsSync(this.configFile))
      this.saveConfig({
        version: TEAM_SCHEMA_VERSION,
        team_name: 'default',
        members: [],
      })
    mkdirSync(join(this.inboxDir), { recursive: true })
    if (!existsSync(this.inboxPath(LEAD_ACTOR)))
      writeFileSync(this.inboxPath(LEAD_ACTOR), '', 'utf8')
  }
}

function atomicWriteJson(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID().replace(/-/g, '')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}
