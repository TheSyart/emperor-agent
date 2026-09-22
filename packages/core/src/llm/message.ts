/** Message value types, identity, and immutable construction helpers (ported from dsh-llm). */

import { randomUUID } from 'node:crypto'
import { frozenCopy } from './freeze'
import type {
  AssistantMessage,
  AssistantProvenance,
  ContentBlock,
  ContextForm,
  Message,
  MessageSource,
  StreamChunk,
  ToolResultMessage,
  UserMessage,
} from './types'

export type {
  AssistantMessage,
  AssistantProvenance,
  ContextForm,
  ContextMessageSource,
  Message,
  MessageSource,
  ModelMessageSource,
  ToolMessageSource,
  ToolResultMessage,
  UserMessage,
} from './types'

/** Bound for a `notice` summary. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/** Bound one notice summary to {@link CONTEXT_SUMMARY_MAX_CHARS}. */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/** Detach and deep-freeze a message whose identity already exists. */
export function freezeMessage<T extends Message>(message: T): T {
  return frozenCopy(message)
}

/** Create one identified message and freeze it before publication. */
export function createMessage<T extends Omit<Message, 'id'>>(
  input: T,
): T & { readonly id: string } {
  return freezeMessage({ ...input, id: randomUUID() })
}

/** Create one identified user-role message. */
export function createUserMessage(input: {
  content: ContentBlock[]
  source: MessageSource
}): UserMessage {
  return createMessage({
    role: 'user' as const,
    content: input.content,
    source: input.source,
  })
}

/** Create one plain user-typed text message. */
export function userText(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Create one harness context message. */
export function contextMessage(
  producer: string,
  text: string,
  extra: { form?: ContextForm; summary?: string } = {},
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'context',
      producer,
      ...(extra.form === undefined ? {} : { form: extra.form }),
      ...(extra.summary === undefined
        ? {}
        : { summary: boundContextSummary(extra.summary) }),
    },
  })
}

/** Create one identified model-produced assistant message. */
export function createAssistantMessage(input: {
  content: ContentBlock[]
  source: AssistantProvenance
}): AssistantMessage {
  return createMessage({
    role: 'assistant' as const,
    content: input.content,
    source: { kind: 'model' as const, ...input.source },
  })
}

/** Create and freeze one identified tool-result message. */
export function createToolResultMessage(input: {
  callId: string
  content: ContentBlock[]
  isError: boolean
}): ToolResultMessage {
  return freezeMessage({
    id: randomUUID(),
    role: 'user' as const,
    source: { kind: 'tool' as const, callId: input.callId },
    content: [
      {
        type: 'tool-result' as const,
        toolCallId: input.callId,
        content: input.content,
        isError: input.isError,
      },
    ],
  })
}

/** Join the top-level text blocks of a message. */
export function messageText(message: Pick<Message, 'content'>): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/** Whether a stream chunk carries visible model output (first-token boundary). */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}
