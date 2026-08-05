import { describe, expect, it } from 'vitest'
import type {
  AssistantMessage,
  ChatMessage,
  TurnChangeSnapshot,
} from '../../types'
import { turnChangesByAssistantMessage } from './turnChangesAttachmentModel'

function assistant(id: string, turnId: string): AssistantMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    segments: [],
    streaming: false,
    turn_id: turnId,
  }
}

function snapshot(
  seq: number,
  overrides: Partial<TurnChangeSnapshot> = {},
): TurnChangeSnapshot {
  return {
    version: 2,
    sessionId: 'session-1',
    turnId: 'turn-root',
    executionId: 'execution-1',
    rootTurnId: 'turn-root',
    activeTurnId: 'turn-resume',
    status: 'complete',
    filesChanged: 1,
    additions: 12,
    deletions: 3,
    binaryFiles: 0,
    truncated: false,
    files: [],
    seq,
    updatedAt: seq,
    ...overrides,
  }
}

describe('final turn changes attachment', () => {
  it('attaches one execution snapshot only to its latest active assistant turn', () => {
    const messages: ChatMessage[] = [
      assistant('assistant-root', 'turn-root'),
      assistant('assistant-resume', 'turn-resume'),
    ]

    const byMessage = turnChangesByAssistantMessage(messages, [
      snapshot(2),
      snapshot(3, { additions: 18 }),
    ])

    expect([...byMessage.keys()]).toEqual(['assistant-resume'])
    expect(byMessage.get('assistant-resume')?.additions).toBe(18)
  })

  it('falls back to turnId and ignores tracking snapshots', () => {
    const messages: ChatMessage[] = [assistant('assistant-root', 'turn-root')]

    const byMessage = turnChangesByAssistantMessage(messages, [
      snapshot(1, { status: 'tracking' }),
      snapshot(2, { activeTurnId: 'missing-turn' }),
    ])

    expect([...byMessage.keys()]).toEqual(['assistant-root'])
  })
})
