/**
 * First-run profile interview on the harness kernel. The interview is one
 * hidden turn in a chat session: the model asks through
 * `ask_user_question` (which blocks inside the turn until the user answers
 * from the control panel) and saves the profile with `memory_edit`
 * (target `user`). It starts only when the user asks for it (UI-S17); the
 * coordinator's state decides whether it may.
 */

import {
  ProfileOnboardingCoordinator,
  profileOnboardingAgentPrompt,
  type ProfileOnboardingActionResult,
  type ProfileOnboardingPayload,
} from '../../sessions/onboarding'
import type { SessionEntry } from '../../sessions/store'

export interface OnboardingServiceDeps {
  stateRoot: string
  templatesDir: string
  userFile: string
  readUserProfile(): string
  modelAvailable(): boolean
  anyBusy(): boolean
  hasPending(sessionId: string): boolean
  /** Pending interaction id of a session, if any. */
  pendingInteractionId(sessionId: string): string | null
  onPendingChange(listener: (sessionId: string) => void): () => void
  /** After the agent writes the profile (memory_edit, target user). */
  onProfileWrite(listener: () => void): () => void
  sessions: {
    list(opts?: { includeArchived?: boolean }): SessionEntry[]
    create(title: string, opts: { mode: string }): SessionEntry
  }
  submitHidden(sessionId: string, content: string): Promise<unknown>
  cancelInteraction(interactionId: string): void
  emit(event: Record<string, unknown>): void
}

export class OnboardingService {
  readonly coordinator: ProfileOnboardingCoordinator
  private readonly unsubscribe: () => void
  private readonly unsubscribeProfile: () => void
  /** The 称呼 the renderer last heard about. */
  private addressName: string | null

  constructor(private readonly deps: OnboardingServiceDeps) {
    this.coordinator = new ProfileOnboardingCoordinator({
      stateRoot: deps.stateRoot,
      templatesDir: deps.templatesDir,
      userFile: deps.userFile,
    })
    // Interviews do not survive restarts: the blocked turn is repaired away.
    this.coordinator.reconcilePendingInteraction(null)
    this.unsubscribe = deps.onPendingChange((sessionId) => {
      const state = this.coordinator.payload()
      if (state.status !== 'in_progress' || state.sessionId !== sessionId)
        return
      const pendingId = deps.pendingInteractionId(sessionId)
      if (pendingId !== null && pendingId !== state.interactionId) {
        this.coordinator.attachInteraction(pendingId)
        this.emitStatus('awaiting_answers')
      }
    })
    this.addressName = this.coordinator.payload().addressName
    this.unsubscribeProfile = deps.onProfileWrite(() => {
      this.profileWritten()
    })
  }

  payload(): ProfileOnboardingPayload {
    return this.coordinator.reconcileProfile()
  }

  /** Called after the profile file may have changed (config saves). */
  reconcile(): ProfileOnboardingPayload {
    const before = this.coordinator.payload().status
    const state = this.coordinator.reconcileProfile()
    if (before !== state.status || state.addressName !== this.addressName)
      this.emitStatus('profile_saved')
    return state
  }

  /**
   * The agent wrote the profile. A running interview keeps going (it may
   * still ask and save more; it settles when its turn ends); otherwise the
   * write counts like a config save. Either way a changed 称呼 is pushed.
   */
  private profileWritten(): void {
    if (this.coordinator.payload().status !== 'in_progress') {
      this.reconcile()
      return
    }
    if (this.coordinator.payload().addressName !== this.addressName)
      this.emitStatus('profile_saved')
  }

  isInterviewInteraction(interactionId: string): boolean {
    const state = this.coordinator.payload()
    return (
      state.status === 'in_progress' && state.interactionId === interactionId
    )
  }

  /**
   * The user asked for the interview (the hero's 开始访谈, 设置 › 记忆). It
   * never starts by itself (UI-S17: not even after the first model).
   */
  start(): ProfileOnboardingActionResult {
    const reconciled = this.coordinator.reconcileProfile()
    if (reconciled.status === 'completed')
      return { started: false, state: reconciled }
    if (!this.deps.modelAvailable() || this.deps.anyBusy())
      return { started: false, state: reconciled }
    const session = this.interviewSession()
    if (this.deps.hasPending(session.id))
      return { started: false, state: reconciled }
    const attempt = this.coordinator.beginAttempt(session.id, { manual: true })
    if (!attempt.started) return attempt
    this.emitStatus('started')
    const prompt = profileOnboardingAgentPrompt(
      this.coordinator.seedContent,
      this.deps.readUserProfile(),
    )
    void this.deps.submitHidden(session.id, prompt).then(
      () => {
        this.settle(null)
      },
      (error: unknown) => {
        this.settle(error)
      },
    )
    return { started: true, state: this.coordinator.payload() }
  }

  skip(): ProfileOnboardingActionResult {
    const state = this.coordinator.payload()
    if (
      state.interactionId !== null &&
      this.isInterviewInteraction(state.interactionId)
    ) {
      this.deps.cancelInteraction(state.interactionId)
    }
    const skipped = this.coordinator.skip()
    this.emitStatus('skipped')
    return { started: false, state: skipped }
  }

  dispose(): void {
    this.unsubscribe()
    this.unsubscribeProfile()
  }

  private settle(error: unknown): void {
    const before = this.coordinator.payload()
    if (before.status !== 'in_progress') return
    const state = this.coordinator.reconcileProfile()
    if (state.status === 'completed') {
      this.emitStatus('completed')
      return
    }
    this.coordinator.fail(
      error ?? 'profile interview ended before the profile was saved',
    )
    this.emitStatus('failed')
  }

  private interviewSession(): SessionEntry {
    const sessions = this.deps.sessions.list({ includeArchived: false })
    return (
      sessions.find(
        (session) => session.mode === 'chat' && session.title === 'Default',
      ) ??
      sessions.find((session) => session.mode === 'chat') ??
      this.deps.sessions.create('Default', { mode: 'chat' })
    )
  }

  private emitStatus(reason: string): void {
    this.addressName = this.coordinator.payload().addressName
    try {
      this.deps.emit({
        event: 'profile_onboarding_status_changed',
        profile_onboarding: { ...this.coordinator.payload() },
        reason,
      })
    } catch {
      // observability never alters onboarding state
    }
  }
}
