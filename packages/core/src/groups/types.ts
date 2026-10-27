/**
 * Group chat vocabulary (GRP-06, docs/design/agent-contacts.md). A group is
 * a session whose log records only coordination: who said what to whom. Every
 * message carries an audience (who has it in context) and an ask (who must
 * answer); the user sees every message, private ones included.
 */

/** A contact id (contacts/types.ts); kept a plain string here. */
export type ContactId = string

/** 设置 › 群聊 › 协作方式: who decides when nobody is @-mentioned. */
export type Collaboration = 'autonomous' | 'moderated'

export type Audience =
  | { kind: 'all' }
  /** Visible to all, addressed to these. */
  | { kind: 'members'; ids: ContactId[] }
  /** Only `to` and the sender have it in context. */
  | { kind: 'private'; to: ContactId }

/** relay: the asked answer in turn, each seeing the previous; independent: blind, all at once. */
export type AnswerMode = 'relay' | 'independent'

export type GroupMessageKind =
  'say' | 'task' | 'result' | 'summary' | 'system' | 'pass'

export type GroupTaskAccess = 'group_files' | 'readonly' | 'isolated_worktree'

export type GroupTaskState =
  'queued' | 'waiting_user' | 'running' | 'done' | 'failed' | 'cancelled'

export interface GroupTask {
  taskId: string
  to: ContactId
  title: string
  deliverable: string
  basis?: string
  access: GroupTaskAccess
  state: GroupTaskState
  /** The chain of assigners, oldest first; a task never goes back up it. */
  chain?: ContactId[]
}

export interface GroupMessage {
  id: string
  turnId: string
  from: 'user' | 'system' | ContactId
  audience: Audience
  ask: ContactId[]
  answerMode: AnswerMode
  /** Shared by the answers of one independent ask; hidden until revealed. */
  batchId?: string
  kind: GroupMessageKind
  text: string
  replyTo?: string
  task?: GroupTask
  /** Epoch milliseconds. */
  at: number
}

export interface GroupSettings {
  collaboration: Collaboration
  /** 安静模式: only @ starts anyone speaking. */
  quiet: boolean
  summarizeAtEnd: boolean
  loopGuard: boolean
}

/** What the protocol needs to know about a contact in the group. */
export interface GroupMember {
  id: ContactId
  name: string
  intro: string
  /** Claude Code or Codex: can @ others in text but has no group tools. */
  external?: boolean
}
