import type { ChatMessage, TurnChangeSnapshot } from '../../types'

export function turnChangesByAssistantMessage(
  messages: ChatMessage[],
  snapshots: TurnChangeSnapshot[],
): Map<string, TurnChangeSnapshot> {
  const latestByExecution = new Map<string, TurnChangeSnapshot>()
  for (const snapshot of snapshots) {
    if (
      (snapshot.status !== 'complete' && snapshot.status !== 'partial') ||
      snapshot.filesChanged <= 0
    ) {
      continue
    }
    const key = snapshot.executionId
      ? `execution:${snapshot.executionId}`
      : `turn:${snapshot.turnId}`
    const current = latestByExecution.get(key)
    if (!current || snapshot.seq >= current.seq)
      latestByExecution.set(key, snapshot)
  }

  const byMessage = new Map<string, TurnChangeSnapshot>()
  for (const snapshot of latestByExecution.values()) {
    const message = targetAssistantMessage(messages, snapshot)
    if (!message) continue
    const existing = byMessage.get(message.id)
    if (!existing || snapshot.seq >= existing.seq)
      byMessage.set(message.id, snapshot)
  }
  return byMessage
}

function targetAssistantMessage(
  messages: ChatMessage[],
  snapshot: TurnChangeSnapshot,
): Extract<ChatMessage, { role: 'assistant' }> | null {
  const turnIds = [
    snapshot.activeTurnId,
    snapshot.turnId,
    snapshot.rootTurnId,
  ].filter((turnId, index, all): turnId is string => {
    return Boolean(turnId) && all.indexOf(turnId) === index
  })

  for (const turnId of turnIds) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'assistant' && message.turn_id === turnId)
        return message
    }
  }
  return null
}
