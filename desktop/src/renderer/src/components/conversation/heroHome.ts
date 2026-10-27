/**
 * What the home of an empty session lets through (MOD-03,
 * docs/design/modes.md § 首页): a Build home sends nothing before it has a
 * project, a starter only fills the composer, and the first-run guide
 * (UI-S17) comes before the home's starters and recent projects.
 */
import type { AppMode } from '../../runtime/appMode'
import type { HeroModelState } from '../onboarding/firstRunGate'

/** The send button's reason on a Build home without a project. */
export const PICK_PROJECT_FIRST = '先选一个项目'

/**
 * Why the composer cannot send ('' when it can): the model's problem
 * first, then — on a Build home only — the missing project. Past the home
 * (a conversation under way) the project rule no longer applies.
 */
export function homeSendBlockedReason(input: {
  modelReason: string
  home: boolean
  mode: AppMode
  projectPath?: string | null
}): string {
  if (input.modelReason) return input.modelReason
  if (input.home && input.mode === 'build' && !input.projectPath?.trim())
    return PICK_PROJECT_FIRST
  return ''
}

/**
 * The home's starters and recent projects wait while the first-run guide
 * is open, and while there is no model at all: the hero then offers
 * 开始接入 only (HeroModelPrompt). A model that needs a repair does not
 * hold them back.
 */
export function heroExtrasShown(input: {
  firstRunOpen: boolean
  modelState: HeroModelState | null
}): boolean {
  return !input.firstRunOpen && input.modelState?.kind !== 'setup'
}

/** The composer as a starter reaches it. */
export interface StarterTarget {
  setDraft: (text: string) => void
  focusInput: () => void
}

/** A starter fills the composer (after what was typed) and never sends. */
export function fillSuggestion(
  composer: StarterTarget | null | undefined,
  draft: string,
): void {
  if (!composer) return
  composer.setDraft(draft)
  composer.focusInput()
}
