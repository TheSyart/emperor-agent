/**
 * 回合暂停动作（W7：从 AgentRunner 下沉）。
 * Ask-Guard 澄清暂停、Plan 终局暂停、控制交互暂停时的 tool_use↔tool_result
 * 配对补齐（INV-001）。与 runner 内原实现语义逐字一致。
 */
import { TurnPaused } from '../control/exceptions'
import { interactionToDict } from '../control/models'
import { parsePauseResult } from '../control/tools'
import type { ToolCallRequest } from '../providers/base'
import type { CheckpointWriteOptions } from '../sessions/checkpoint'
import type { ToolResultObj } from '../tools/base'
import { controlInteractionEvent } from './runner-helpers'
import type { ControlManagerRunnerHost, MemoryStoreLike } from './runner'

type Msg = Record<string, unknown>
type StreamEmitter = (event: Record<string, unknown>) => void | Promise<void>

export interface PauseHost {
  controlManager: ControlManagerRunnerHost | null
  memoryStore: MemoryStoreLike | null
}

export async function pauseForClarification(
  host: PauseHost,
  history: Msg[],
  clarification: { reason: string; questions: Array<Record<string, unknown>> },
  emit: StreamEmitter | null,
  turnId: string | null,
): Promise<void> {
  if (host.controlManager === null) return
  const interaction = host.controlManager.createAsk({ questions: clarification.questions, context: `Ask Guard: ${clarification.reason}` })
  const message: Msg = { role: 'assistant', content: '需要先确认关键取舍，已触发 Ask Guard。' }
  if (turnId) message.turn_id = turnId
  history.push(message)
  if (host.memoryStore !== null) host.memoryStore.writeCheckpoint(history, pauseCheckpointOpts(turnId))
  const payload = interactionToDict(interaction)
  if (emit) {
    await emit(controlInteractionEvent(payload))
    await emit({ event: 'turn_paused', interaction: payload })
  }
  throw new TurnPaused(payload, [])
}

export async function pauseForPlan(
  host: PauseHost,
  history: Msg[],
  reply: string,
  emit: StreamEmitter | null,
  turnId: string | null,
): Promise<void> {
  if (host.controlManager === null) return
  const interaction = host.controlManager.createPlanFromText(reply)
  const message: Msg = { role: 'assistant', content: reply }
  if (turnId) message.turn_id = turnId
  history.push(message)
  if (host.memoryStore !== null) host.memoryStore.writeCheckpoint(history, pauseCheckpointOpts(turnId))
  const payload = interactionToDict(interaction)
  if (emit) {
    await emit(controlInteractionEvent(payload))
    await emit({ event: 'turn_paused', interaction: payload })
  }
  throw new TurnPaused(payload, [])
}

function pauseCheckpointOpts(turnId: string | null): CheckpointWriteOptions {
  return { turnId, phase: 'assistant_response_pending' }
}

export function maybePauseForControl(content: string, toolCalls: ToolCallRequest[], resultsById: Map<string, ToolResultObj>): void {
  const interaction = parsePauseResult(content)
  if (interaction === null) return
  const toolMessages = toolMessagesForPause(toolCalls, resultsById, interaction)
  throw new TurnPaused(interaction, toolMessages)
}

export function toolMessagesForPause(toolCalls: ToolCallRequest[], resultsById: Map<string, ToolResultObj>, interaction: Record<string, unknown>): Msg[] {
  const messages: Msg[] = []
  let currentId = String(interaction.parent_call_id ?? '')
  for (const call of toolCalls) {
    const result = resultsById.get(call.id)
    let content: string | null = result !== undefined ? result.modelContent : null
    if (content && parsePauseResult(content)) {
      content = `waiting for user (${interaction.kind}:${interaction.id})`
    } else if (content === null) {
      content = 'skipped because the turn paused for user input'
    }
    messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content })
    if (currentId && call.id === currentId) currentId = ''
  }
  return messages
}
