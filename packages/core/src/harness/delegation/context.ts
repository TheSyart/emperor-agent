import type { InstructionFile } from '../prompt/agent-instructions'
import { DelegationError } from './types'
export interface DelegationBriefInput {
  prompt: string
  description: string
  context: 'isolated' | 'brief'
  instructions?: InstructionFile[]
  goal?: string
  workspace?: {
    cwd: string
    base: string
    commit?: string
    manifestDigest?: string
    excluded?: { path: string; reason: string }[]
  }
}
/** Explicit handoff values only: parent system/history/reasoning/credentials never enter this builder. */
export function buildDelegationBrief(input: DelegationBriefInput): string {
  const parts = ['Task: ' + input.description, input.prompt]
  if (input.goal) parts.push('Parent task objective: ' + input.goal)
  if (input.workspace) {
    const w = input.workspace
    parts.push(
      'Workspace baseline: ' +
        JSON.stringify({
          cwd: w.cwd,
          base: w.base,
          commit: w.commit,
          manifestDigest: w.manifestDigest,
          excluded: w.excluded,
        }),
    )
  }
  for (const file of input.instructions ?? [])
    parts.push(
      'Workspace constraints from ' + file.displayPath + ':\n' + file.content,
    )
  const brief = parts.join('\n\n')
  if (!input.prompt.trim())
    throw new DelegationError('INVALID_REQUEST', 'delegation prompt is empty')
  if (Buffer.byteLength(brief) > 32 * 1024)
    throw new DelegationError(
      'BRIEF_LIMIT',
      'complete task brief exceeds 32 KiB; select less context or reference workspace files',
    )
  return brief
}
