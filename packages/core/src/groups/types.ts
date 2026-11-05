/**
 * Group chat vocabulary (GRP-06, docs/design/agent-contacts.md). A group is
 * a session whose log records only coordination: who said what to whom. Every
 * message carries an audience (who has it in context) and an ask (who must
 * answer); the user sees every message, private ones included.
 */

/** A contact id (contacts/types.ts); kept a plain string here. */
export type ContactId = string

/** Autonomous for every group; `moderated` is accepted only when replaying old logs. */
export type Collaboration = 'autonomous' | 'moderated'

/** New groups coordinate themselves; `member` exists only to replay old logs. */
export type Coordination = 'builtin' | 'member'

export type Audience =
  | { kind: 'all' }
  /** Visible to all, addressed to these. */
  | { kind: 'members'; ids: ContactId[] }
  /** Only `to` and the sender have it in context. */
  | { kind: 'private'; to: ContactId }

/** relay: the asked answer in turn, each seeing the previous; independent: blind, all at once. */
export type AnswerMode = 'relay' | 'independent'

export type GroupMessageKind =
  'say' | 'task' | 'result' | 'summary' | 'system' | 'pass' | 'coordination'

export type GroupTaskAccess = 'group_files' | 'readonly' | 'isolated_worktree'

export type GroupTaskState =
  | 'queued'
  | 'waiting_user'
  | 'running'
  | 'submitted'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface GroupTaskArtifact {
  ref: string
  revision: string
}

export interface GroupTaskCheck {
  artifactRevision: string
  evidenceRef: string
  passed: boolean
}

/** A run that could not produce a candidate; earlier artifacts stay intact. */
export interface GroupTaskProblem {
  kind: 'failed' | 'unknown' | 'adapter'
  reason: string
  runId?: string
}

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
  /**
   * The user agreed to it (GRP-09): their own task, or one a member handed
   * out that they confirmed. Only a confirmed task may change code in an
   * isolated worktree; any other external run is read-only.
   */
  confirmed?: boolean
  /**
   * Why a `waiting_user` task waits, when it is not a code change (GRP-15):
   * `task_relay`, its member had already handed out tasks in
   * TASK_RELAY_LIMIT speeches this turn. 「继续」 or 同意 runs it; 不同意
   * cancels it.
   */
  hold?: 'task_relay'
  /** CG-02: optional collaboration contract; legacy tasks omit every field. */
  idempotencyKey?: string
  acceptance?: string[]
  dependsOn?: string[]
  contractRevision?: number
  writeScopes?: string[]
  attempt?: number
  leaseEpoch?: number
  activeRunId?: string
  artifacts?: GroupTaskArtifact[]
  checks?: GroupTaskCheck[]
  problem?: GroupTaskProblem
}

export interface GroupTaskView extends GroupTask {
  /** Queued, unclaimed, and every dependency has been accepted. */
  ready: boolean
}

export interface GroupCoordination {
  kind: 'arrangement' | 'plan' | 'conclusion'
  speakers?: ContactId[]
  tasks?: GroupTask[]
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
  /** The question/approval anchored immediately after this source speech. */
  interactionId?: string
  task?: GroupTask
  /** A system arrangement/plan/conclusion; never a member's speech. */
  coordination?: GroupCoordination
  /** An external member's task result: the run whose card applies or discards it (GRP-09). */
  delegation?: { id: string; runId: string }
  /** Epoch milliseconds. */
  at: number
}

export interface GroupSettings {
  collaboration: Collaboration
  coordination: Coordination
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
  /**
   * The job card's 群聊习惯: speak only when @-mentioned, raise a hand when
   * the topic is theirs (the default), or always answer a broadcast.
   */
  speak?: 'mentioned' | 'relevant' | 'always'
}

/** What the user did with a member's question or approval (GRP-12). */
export type GroupAnswerOutcome = 'answered' | 'approved' | 'denied' | 'skipped'

/** What the member asked: a question, an approval, or a plan to review. */
export type GroupAnswerSubject = 'question' | 'approval' | 'plan'

/**
 * The user's answer to a member who asked during its speech, kept in the
 * group log for the user only (GRP-12): 「你回答了 架构师 的提问：…」.
 */
export interface GroupAnswerNote {
  id: string
  /** The group's latest turn when it was given (null before any). */
  turnId: string | null
  /** The member who asked. */
  contactId: ContactId
  outcome: GroupAnswerOutcome
  subject: GroupAnswerSubject
  /** What was asked: the question, what the approval is for, the plan's title. */
  asked: string
  /** The user's reply: the options and own words; an approval's button. */
  reply: string
  /** Epoch milliseconds. */
  at: number
}
