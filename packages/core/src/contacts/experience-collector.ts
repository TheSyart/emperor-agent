/**
 * Distills a finished contact turn into working experiences (CP-04).
 *
 * Only the member's own turn is read. Evidence is what the host checked:
 * a successful tool result, or a user confirmation/correction; the model
 * may cite only those refs, and a claim without one stays a candidate and
 * is never recalled. At most five entries and a small token budget per
 * turn; a failure is recorded on the contact, never retried by itself.
 */
import {
  EXPERIENCE_MAX_PER_TURN,
  type ContactExperience,
  type ContactExperienceStore,
  type ExperienceDraft,
  type ExperienceEvidence,
  type ExperienceScope,
} from './experiences'

export interface ExperienceTurnItem {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** Tool call id (tool), message id (user/assistant). */
  ref: string
  /** Tool results: whether it failed. */
  failed?: boolean
}

export interface ExperienceTurn {
  contactId: string
  contactName: string
  sessionId: string
  turnId: string
  roleVersion: number
  scope: ExperienceScope
  items: ExperienceTurnItem[]
  messageIds: string[]
}

export interface ExperienceCollectorDeps {
  store: ContactExperienceStore
  /** One short call on a model; '' when no model is available. */
  complete: (input: {
    contactId: string
    system: string
    prompt: string
    maxTokens: number
    signal: AbortSignal
  }) => Promise<string>
  recordUsage?: (contactId: string) => void
  now?: () => number
}

const SYSTEM = [
  '你从一次已经结束的工作里提炼可复用的经验，供这位联系人以后的工作直接参考。',
  '只输出一个 JSON 数组，最多 5 条；没有值得留下的经验就输出 []。',
  '每条：{"text":"下一步能照着做的结论，不超过 80 字","conditions":"适用条件，不超过 60 字，可空","scope":"contact|session|group|project","evidenceRefs":["依据编号"]}',
  '依据只有三种：工具的成功结果、用户的确认、用户的纠正。模型自己的总结不算依据；没有依据的条目仍然可以写，但 evidenceRefs 留空，它只会成为待验证。',
  '不要把私信内容、项目事实或一次性的数字写成通用经验；默认 scope 用 contact，只有确实只在这一段工作里成立时才用 session/group/project。',
  '不要编造依据编号；只能引用下面列出的编号。',
].join('\n')

function clip(text: string, chars: number): string {
  return Array.from(text).slice(0, chars).join('')
}

/** The host-checked evidence in this turn. */
export function turnEvidence(
  items: readonly ExperienceTurnItem[],
): ExperienceEvidence[] {
  const evidence: ExperienceEvidence[] = []
  for (const item of items) {
    if (item.role === 'tool' && item.failed !== true && item.text.trim())
      evidence.push({ kind: 'tool_result', ref: item.ref })
  }
  const users = items.filter((item) => item.role === 'user')
  const assistants = items.filter((item) => item.role === 'assistant')
  if (users.length && assistants.length) {
    const lastUser = users.at(-1)!
    const correction = /不要|不对|错了|改成|不是|应该|纠正|重新/u.test(
      lastUser.text,
    )
    const confirmation = /可以|对|好的|继续|同意|就这样|没问题/u.test(
      lastUser.text,
    )
    if (correction)
      evidence.push({ kind: 'user_correction', ref: lastUser.ref })
    else if (confirmation)
      evidence.push({ kind: 'user_confirmation', ref: lastUser.ref })
  }
  return evidence
}

function transcript(items: readonly ExperienceTurnItem[]): string {
  return items
    .map((item) => {
      const role =
        item.role === 'tool'
          ? `工具结果${item.failed ? '（失败）' : ''}`
          : item.role === 'user'
            ? '用户'
            : '你'
      return `[${item.ref}] ${role}：${clip(item.text, 600)}`
    })
    .join('\n')
}

interface RawDraft {
  text?: unknown
  conditions?: unknown
  scope?: unknown
  evidenceRefs?: unknown
}

function parseDrafts(text: string): RawDraft[] | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const value = JSON.parse(trimmed) as unknown
    return Array.isArray(value) ? (value as RawDraft[]) : null
  } catch {
    return null
  }
}

function scopeOf(value: unknown, fallback: ExperienceScope): ExperienceScope {
  if (value === 'session') return { kind: 'session', id: fallback.id }
  if (value === 'group') return { kind: 'group', id: fallback.id }
  if (value === 'project') return { kind: 'project', id: fallback.id }
  return { kind: 'contact' }
}

export class ContactExperienceCollector {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly deps: ExperienceCollectorDeps) {}

  /**
   * Queues one turn's distillation; never blocks the turn or throws at the
   * caller. A contact's turns run one after another so the file is not
   * written by two distillations at once.
   */
  collect(turn: ExperienceTurn): void {
    const previous = this.queues.get(turn.contactId) ?? Promise.resolve()
    const run = previous.then(() => this.run(turn)).catch(() => undefined)
    this.queues.set(turn.contactId, run)
  }

  private async run(turn: ExperienceTurn): Promise<void> {
    const evidence = turnEvidence(turn.items)
    const worth =
      evidence.some((item) => item.kind === 'tool_result') ||
      turn.items.some(
        (item) =>
          item.role === 'assistant' && clip(item.text, 200).trim().length > 80,
      )
    if (!worth) return
    const allowed = new Map(evidence.map((item) => [item.ref, item]))
    let answer = ''
    try {
      answer = await this.deps.complete({
        contactId: turn.contactId,
        system: SYSTEM,
        prompt: [
          `联系人：${turn.contactName}`,
          `这一轮的工作记录（方括号是依据编号）：`,
          clip(transcript(turn.items), 6000),
          '',
          '可用依据：',
          [...allowed.values()]
            .map((item) => `- ${item.ref}（${item.kind}）`)
            .join('\n') || '（没有可引用的依据）',
        ].join('\n'),
        // Reasoning models spend part of this budget before emitting JSON.
        maxTokens: 1600,
        signal: new AbortController().signal,
      })
    } catch (error) {
      await this.deps.store.noteError(turn.contactId, String(error))
      return
    }
    if (!answer.trim()) return
    const raw = parseDrafts(answer)
    if (raw === null) {
      await this.deps.store.noteError(
        turn.contactId,
        '整理结果不是 JSON，这一次没有留下经验',
      )
      return
    }
    const drafts: ExperienceDraft[] = []
    for (const item of raw.slice(0, EXPERIENCE_MAX_PER_TURN)) {
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (!text) continue
      const refs = Array.isArray(item.evidenceRefs)
        ? item.evidenceRefs.filter(
            (ref): ref is string => typeof ref === 'string' && allowed.has(ref),
          )
        : []
      drafts.push({
        text,
        conditions: typeof item.conditions === 'string' ? item.conditions : '',
        scope: scopeOf(item.scope, turn.scope),
        evidence: refs.map((ref) => allowed.get(ref)!),
        status: refs.length ? 'active' : 'candidate',
      })
    }
    if (!drafts.length) return
    const added: ContactExperience[] = await this.deps.store.add(
      turn.contactId,
      drafts,
      {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        messageIds: turn.messageIds,
        roleVersion: turn.roleVersion,
      },
    )
    if (added.length) this.deps.recordUsage?.(turn.contactId)
  }
}
