// Glyphs of the Pull Request page (lucide, currentColor). Kept in one place
// so the list, detail and empty states share the same vocabulary.
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  KeyRound,
  ListFilter,
  TerminalSquare,
  CloudOff,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type { CheckOutcome } from './pullRequestModel'

export const pullIcons = {
  back: ArrowLeft,
  collapse: ChevronDown,
  expand: ChevronRight,
  external: ExternalLink,
  filter: ListFilter,
  pull: GitPullRequest,
  missing: TerminalSquare,
  login: KeyRound,
  failed: CloudOff,
} as const satisfies Record<string, Component>

/** PR glyph by state (open / draft / merged / closed). */
export function pullStateIcon(state: string, isDraft: boolean): Component {
  if (state === 'MERGED') return GitMerge
  if (state === 'CLOSED') return GitPullRequestClosed
  if (isDraft) return GitPullRequestDraft
  return GitPullRequest
}

export const checkOutcomeIcons: Readonly<Record<CheckOutcome, Component>> = {
  success: CircleCheck,
  failure: CircleX,
  pending: CircleDashed,
  neutral: CircleMinus,
}
