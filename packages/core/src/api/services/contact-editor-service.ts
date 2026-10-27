/**
 * What the contact editor asks Core for (GRP-04): a recommended avatar, a
 * draft from a few sentences, an imported agent file, the compiled prompt
 * of the unsaved draft, and a trial run of it. None of these saves the
 * contact; `contacts.create` / `contacts.update` do, when the user saves.
 * The two model calls (drafting, the trial) run only when the user presses
 * their button.
 */
import {
  recommendContactAvatar,
  type ContactAvatarRecommendDeps,
} from '../../contacts/avatars'
import {
  draftFromBrief,
  type BriefDraftDeps,
  type DraftFromBriefInput,
  type DraftFromBriefResult,
} from '../../contacts/draft'
import { ContactValidationError } from '../../contacts/errors'
import { importAgentFile, type AgentFileImport } from '../../contacts/import'
import { toolPresetTable, type ContactRuntime } from '../../contacts/runtime'
import type { ContactStore } from '../../contacts/store'
import { TRIAL_TASK_LIMIT, type ContactTrials } from '../../contacts/trials'
import type {
  AvatarTheme,
  ContactDraftInput,
  ContactPreview,
  ContactTrialResult,
} from '../../contacts/types'
import { charCount } from '../../contacts/validate'

export interface ContactEditorServiceDeps {
  contacts: ContactStore
  runtime: ContactRuntime
  trials: ContactTrials
  llm: BriefDraftDeps['llm']
  /** Every tool name the registry has. */
  toolNames(): Iterable<string>
  /** 设置 › 常规 › 会话 › 新会话的权限. */
  globalPermission(): string
  /** Where a preview's knowledge counts as inside the workspace. */
  workspaceRoot(): string
  cost: NonNullable<BriefDraftDeps['cost']>
  record: NonNullable<BriefDraftDeps['record']>
  random?: ContactAvatarRecommendDeps['random']
}

export class CoreContactEditorService {
  constructor(private readonly deps: ContactEditorServiceDeps) {}

  /** A library avatar from the template's theme, skipping the ones in use. */
  async recommendAvatar(input: {
    templateId?: string
    exclude?: string[]
  }): Promise<{ id: string; theme: AvatarTheme }> {
    const [listing, templates] = await Promise.all([
      this.deps.contacts.list(),
      this.deps.contacts.templates(),
    ])
    return recommendContactAvatar(input, {
      contacts: listing.contacts,
      templates,
      ...(this.deps.random ? { random: this.deps.random } : {}),
    })
  }

  draftFromBrief(input: DraftFromBriefInput): Promise<DraftFromBriefResult> {
    return draftFromBrief(input, {
      llm: this.deps.llm,
      globalPermission: () => this.deps.globalPermission(),
      cost: this.deps.cost,
      record: this.deps.record,
    })
  }

  importAgentFile(input: { path: string }): Promise<AgentFileImport> {
    return importAgentFile(input.path, {
      registered: this.deps.toolNames(),
      globalPermission: this.deps.globalPermission(),
    })
  }

  /** The draft's persona section exactly as its sessions would get it. */
  async preview(input: { draft: ContactDraftInput }): Promise<ContactPreview> {
    const contact = await this.deps.contacts.draft(input.draft)
    const { prompt, tools } = this.deps.runtime.preview(
      contact,
      this.deps.workspaceRoot(),
    )
    return {
      prompt,
      chars: charCount(prompt),
      tools,
      presets: toolPresetTable(this.deps.toolNames()),
    }
  }

  async trial(input: {
    draft: ContactDraftInput
    task: string
    trialId: string
  }): Promise<ContactTrialResult> {
    const contact = await this.deps.contacts.draft(input.draft)
    if (contact.kind === 'external')
      throw new ContactValidationError(
        'kind',
        'Claude Code、Codex 的联系人还不能在试用台试用',
      )
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) throw new ContactValidationError('task', '先写一条样例任务')
    if (charCount(task) > TRIAL_TASK_LIMIT)
      throw new ContactValidationError(
        'task',
        `样例任务最多 ${TRIAL_TASK_LIMIT} 字`,
      )
    return this.deps.trials.run(contact, task, input.trialId)
  }

  stopTrial(input: { trialId: string }): { stopped: boolean } {
    return this.deps.trials.stop(input.trialId)
  }
}
