/**
 * Tool-call scheduler (ported from dsh-agent-loop tool-calls.ts).
 *
 * Calls are grouped in model order: a run of consecutive parallel-safe
 * calls shares a rolling pool capped at `maxParallel`; an exclusive call
 * runs alone and acts as a barrier. `tool/call` events and pre-execute run
 * in model order; only bodies overlap; post-execute and `tool/result`
 * commit strictly in model order. On abort, calls that never started get
 * synthetic `ABORTED_BEFORE_DISPATCH` results so every call has a result.
 */

import { createToolResultMessage, type UserMessage } from '../../llm/message'
import type { ToolCallBlock } from '../../llm/types'
import type { Session } from '../../session-log/session'
import {
  toolAbortedResult,
  type ToolExecutionResult,
  type ToolRunContext,
} from '../tools/definition'
import type { ToolRegistry } from '../tools/registry'
import type { Agent } from './agent'

interface PlannedCall {
  block: ToolCallBlock
  rawArguments: unknown
}

interface Slot {
  context: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

export interface ToolCallBatch {
  agent: Agent
  tools: ToolRegistry
  maxParallel: number
  turn: number
  step: number
  signal: AbortSignal
  /** Accept one additional context message for the next step. */
  acceptContext: (context: UserMessage) => void
}

function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    // Invalid JSON stays a string and fails validation with a readable error.
    return raw
  }
}

export async function executeToolCalls(
  batch: ToolCallBatch,
  toolCalls: ToolCallBlock[],
): Promise<{ concluded: boolean }> {
  const planned: PlannedCall[] = toolCalls.map((block) => ({
    block,
    rawArguments: parseArguments(block.arguments),
  }))
  let next = 0
  let concluded = false
  while (next < planned.length) {
    const first = planned[next]!
    const mode = batch.tools.executionMode(
      first.block.name,
      first.rawArguments,
      batch.agent,
    )
    const group = mode === 'parallel' ? planned.slice(next) : [first]
    const outcome = await runGroup(batch, group, mode)
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of planned.slice(next))
        appendSkippedToolCall(batch, call.block)
      return { concluded }
    }
  }
  return { concluded }
}

async function runGroup(
  batch: ToolCallBatch,
  group: PlannedCall[],
  mode: 'parallel' | 'exclusive',
): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
  const { agent, tools, signal } = batch
  const session = agent.session
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  const callSeqs: number[] = group.map(() => -1)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted = signal.aborted
  let concluded = false
  let failure: { error: unknown } | undefined
  const throwFailure = (): void => {
    if (failure !== undefined) throw failure.error
  }

  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const result = slot.needsPost
        ? await tools.finalize(slot.context, slot.result)
        : tools.finish(slot.context, slot.result)
      appendToolResult(
        session,
        batch,
        group[committed]!.block,
        result,
        callSeqs[committed]!,
      )
      for (const context of result.additionalContexts ?? [])
        batch.acceptContext(context)
      concluded ||= result.concludesTurn === true
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    const call = group[index]!
    callSeqs[index] = appendToolCall(session, batch, call.block)
    started++
    const prepared = await tools.prepare({
      callId: call.block.id,
      name: call.block.name,
      arguments: call.rawArguments,
      agent,
      signal,
    })
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = tools.dispatch(prepared.context).then(
          (result) => {
            slots[index] = {
              context: prepared.context,
              result,
              needsPost: true,
            }
            return index
          },
          (error: unknown) => {
            failure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = {
          context: prepared.context,
          result: prepared.result,
          needsPost: true,
        }
        break
      case 'final-result':
        slots[index] = {
          context: prepared.context,
          result: prepared.result,
          needsPost: false,
        }
        break
    }
  }

  const fillPool = async (): Promise<void> => {
    while (
      !aborted &&
      nextToStart < group.length &&
      inFlight.size < batch.maxParallel
    ) {
      const nextCall = group[nextToStart]!
      if (
        nextToStart > 0 &&
        mode === 'parallel' &&
        tools.executionMode(
          nextCall.block.name,
          nextCall.rawArguments,
          agent,
        ) !== 'parallel'
      )
        break
      await startCall(nextToStart)
      nextToStart++
      throwFailure()
      await commitReady()
      throwFailure()
      if (signal.aborted) aborted = true
    }
  }

  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settled = await Promise.race(inFlight.values())
      inFlight.delete(settled)
      throwFailure()
      await commitReady()
      throwFailure()
      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    failure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw failure.error
  }

  if (aborted) {
    for (const call of group.slice(started))
      appendSkippedToolCall(batch, call.block)
    return { consumed: group.length, aborted: true, concluded }
  }
  if (committed !== started)
    throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

function appendSkippedToolCall(
  batch: ToolCallBatch,
  block: ToolCallBlock,
): void {
  const session = batch.agent.session
  const callSeq = appendToolCall(session, batch, block)
  appendToolResult(session, batch, block, toolAbortedResult(true), callSeq)
}

function appendToolCall(
  session: Session,
  batch: ToolCallBatch,
  block: ToolCallBlock,
): number {
  return session.append('tool/call', {
    turn: batch.turn,
    step: batch.step,
    callId: block.id,
    name: block.name,
    arguments: block.arguments,
  }).seq
}

function appendToolResult(
  session: Session,
  batch: ToolCallBatch,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: number,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append(
    'tool/result',
    {
      turn: batch.turn,
      step: batch.step,
      message,
      ...(result.error?.info ? { error: result.error.info } : {}),
      ...(result.meta !== undefined ? { meta: result.meta } : {}),
    },
    { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
  )
}
