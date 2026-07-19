import { createHash, randomUUID } from 'node:crypto'
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

export const TEAM_CHECKPOINT_VERSION = 2
export type TeamCheckpointPhase = 'prepared' | 'running' | 'terminal_pending'

export interface TeamEffectReceipt {
  kind: 'runner_result'
  result: string
  reply_required: boolean
  reply_message_id: string | null
  [key: string]: unknown
}

export interface TeamCheckpointPayload {
  version: number
  member: string
  messages: Array<Record<string, unknown>>
  checkpoint_version?: number
  turn_id?: string
  phase?: TeamCheckpointPhase
  base_thread_revision?: string
  final_thread_revision?: string
  pending_cursor_start?: number
  pending_cursor_end?: number
  pending_message_ids?: string[]
  lead_message_ids_before?: string[]
  last_effect_receipt?: TeamEffectReceipt
}

/** Stable digest used to reject recovery against a different durable thread. */
export function teamThreadRevision(
  messages: Array<Record<string, unknown>>,
): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
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
  hasCheckpoint(name: string): boolean {
    return existsSync(this.checkpointPath(name))
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

  readCheckpointPayload(name: string): TeamCheckpointPayload | null {
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
    const phase =
      payload.phase === 'prepared' ||
      payload.phase === 'running' ||
      payload.phase === 'terminal_pending'
        ? payload.phase
        : undefined
    const receipt =
      payload.last_effect_receipt &&
      typeof payload.last_effect_receipt === 'object' &&
      !Array.isArray(payload.last_effect_receipt)
        ? (payload.last_effect_receipt as Record<string, unknown>)
        : null
    const validReceipt = Boolean(
      receipt?.kind === 'runner_result' &&
      typeof receipt.result === 'string' &&
      typeof receipt.reply_required === 'boolean' &&
      (receipt.reply_message_id === undefined ||
        receipt.reply_message_id === null ||
        typeof receipt.reply_message_id === 'string'),
    )
    return {
      version: Number(payload.version ?? TEAM_SCHEMA_VERSION),
      member: validateMemberName(name),
      messages: payload.messages as Array<Record<string, unknown>>,
      checkpoint_version:
        payload.checkpoint_version === undefined
          ? undefined
          : Number(payload.checkpoint_version),
      turn_id:
        payload.turn_id === undefined ? undefined : String(payload.turn_id),
      phase,
      base_thread_revision:
        payload.base_thread_revision === undefined
          ? undefined
          : String(payload.base_thread_revision),
      final_thread_revision:
        payload.final_thread_revision === undefined
          ? undefined
          : String(payload.final_thread_revision),
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
      lead_message_ids_before: Array.isArray(payload.lead_message_ids_before)
        ? payload.lead_message_ids_before.map(String)
        : undefined,
      last_effect_receipt:
        validReceipt && receipt
          ? {
              ...receipt,
              kind: 'runner_result',
              result: String(receipt.result ?? ''),
              reply_required: receipt.reply_required === true,
              reply_message_id:
                receipt.reply_message_id === undefined ||
                receipt.reply_message_id === null
                  ? null
                  : String(receipt.reply_message_id),
            }
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
      checkpoint_version?: number | null
      turn_id?: string | null
      phase?: TeamCheckpointPhase | null
      base_thread_revision?: string | null
      final_thread_revision?: string | null
      pending_cursor_start?: number | null
      pending_cursor_end?: number | null
      pending_message_ids?: string[] | null
      lead_message_ids_before?: string[] | null
      last_effect_receipt?: TeamEffectReceipt | null
    } = {},
  ): void {
    const payload: Record<string, unknown> = {
      version: TEAM_SCHEMA_VERSION,
      member: validateMemberName(name),
      messages,
    }
    if (
      opts.checkpoint_version !== undefined &&
      opts.checkpoint_version !== null
    )
      payload.checkpoint_version = Math.max(
        0,
        Math.floor(opts.checkpoint_version),
      )
    if (opts.turn_id) payload.turn_id = String(opts.turn_id)
    if (opts.phase) payload.phase = opts.phase
    if (opts.base_thread_revision)
      payload.base_thread_revision = String(opts.base_thread_revision)
    if (opts.final_thread_revision)
      payload.final_thread_revision = String(opts.final_thread_revision)
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
    if (opts.lead_message_ids_before)
      payload.lead_message_ids_before = opts.lead_message_ids_before.map(String)
    if (opts.last_effect_receipt)
      payload.last_effect_receipt = { ...opts.last_effect_receipt }
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
