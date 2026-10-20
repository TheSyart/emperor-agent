/**
 * Serialize harness requests into DeepSeek's Anthropic-compatible Messages
 * shape (KRN-07).
 *
 * - `system` is the top-level string; in-history system messages fold into
 *   a user turn (Messages has no system role in `messages`).
 * - Assistant turns replay text, tool calls, and thinking: with its
 *   signature exactly as received when the same model produced it,
 *   unsigned for the same model's older (chat-completions) reasoning, and
 *   not at all for another model's (see replay.ts).
 * - Tool results become `tool_result` blocks, images nested inside them;
 *   adjacent user turns merge, with tool results first.
 * - Images resolve through `imageSource` (the Files API path) or inline
 *   base64 from the attachment store.
 * - Effort: off → `thinking: disabled`; low / high / max → `thinking:
 *   enabled` + `output_config.effort`; medium folds into high (DeepSeek's
 *   own mapping, https://api-docs.deepseek.com/guides/thinking_mode).
 *   Titles and compaction summaries go without thinking.
 */

import {
  contentHasImage,
  DEFAULT_REQUEST_IMAGE_BYTES,
  offloadRequestImages,
  type ImageResolver,
} from '../../content'
import { LlmError } from '../../error'
import type { Message } from '../../message'
import { deepseekEffort, type RouteSpec } from '../../route'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentRef,
} from '../../types'
import { thinkingSignatures } from './replay'
import type {
  MessagesRequest,
  WireContentBlock,
  WireEffort,
  WireImageBlock,
  WireImageSource,
  WireMessage,
  WireTextBlock,
  WireToolResultBlock,
  WireTool,
} from './types'

type DeepSeekEffort = 'off' | WireEffort

/** Route-level defaults a request falls back to. */
export interface MessagesRequestDefaults {
  reasoningEffort?: DeepSeekEffort
  maxTokens: number
  extraBody?: Readonly<Record<string, unknown>>
}

/** How one image reaches the request: a Files API id, or inline bytes. */
export type ImageSourceResolver = (
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
) => Promise<{ source: WireImageSource; fileId?: string }>

export interface SerializeExtras {
  /** Attachment bytes for inline images. */
  images?: ImageResolver
  /** The Files API path; absent: every image goes inline. */
  imageSource?: ImageSourceResolver
  /** Leave unsigned thinking out (the one repair after a signature error). */
  dropUnsignedThinking?: boolean
}

export interface SerializedRequest {
  body: MessagesRequest
  /** File ids the request references (the beta header goes with them). */
  fileIds: string[]
  /** Whether any thinking block went out without a signature. */
  hasUnsignedThinking: boolean
}

const NO_OUTPUT = '(no output)'

export function messagesRequestDefaults(
  route: RouteSpec,
): MessagesRequestDefaults {
  const effort = route.defaultReasoningEffort
  return {
    maxTokens: route.maxTokens,
    ...(effort === 'off' ||
    effort === 'low' ||
    effort === 'high' ||
    effort === 'max'
      ? { reasoningEffort: effort }
      : {}),
    ...(route.extraBody === undefined ? {} : { extraBody: route.extraBody }),
  }
}

function wireEffort(effort: string): DeepSeekEffort {
  const mapped = deepseekEffort(effort)
  if (
    mapped === 'off' ||
    mapped === 'low' ||
    mapped === 'high' ||
    mapped === 'max'
  )
    return mapped
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function thinkingFields(
  options: GenerateOptions,
  defaults: MessagesRequestDefaults,
): Pick<MessagesRequest, 'thinking' | 'output_config'> {
  if (options.purpose === 'session-title' || options.purpose === 'compaction')
    return { thinking: { type: 'disabled' } }
  const effort =
    options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : wireEffort(options.reasoningEffort)
  if (effort === undefined) return {}
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, output_config: { effort } }
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // A malformed call was answered with an error result; replay it empty.
  }
  return {}
}

class RequestBuilder {
  readonly fileIds: string[] = []
  hasUnsignedThinking = false
  private readonly sources = new Map<string, Promise<WireImageSource>>()

  constructor(
    private readonly model: string,
    private readonly extras: SerializeExtras,
    private readonly signal: AbortSignal | undefined,
  ) {}

  private resolveSource(ref: ImageAttachmentRef): Promise<WireImageSource> {
    const { imageSource, images } = this.extras
    if (imageSource !== undefined)
      return imageSource(ref, this.signal).then((resolved) => {
        if (resolved.fileId !== undefined) this.fileIds.push(resolved.fileId)
        return resolved.source
      })
    if (images === undefined)
      return Promise.reject(
        new LlmError(
          'DeepSeek image input requires the attachment store.',
          'UNSUPPORTED_CONTENT',
        ),
      )
    return images(ref, this.signal).then((resolved) => ({
      type: 'base64' as const,
      media_type: resolved.mediaType,
      data: Buffer.from(resolved.data).toString('base64'),
    }))
  }

  async image(ref: ImageAttachmentRef): Promise<WireImageBlock> {
    let source = this.sources.get(ref.attachmentId)
    if (source === undefined) {
      source = this.resolveSource(ref)
      this.sources.set(ref.attachmentId, source)
    }
    return { type: 'image', source: await source }
  }

  /** Text and images of a user turn or a tool result, in order. */
  async parts(
    blocks: readonly ContentBlock[],
  ): Promise<Array<WireTextBlock | WireImageBlock>> {
    const parts: Array<WireTextBlock | WireImageBlock> = []
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text.length > 0)
          parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push(await this.image(block.attachment))
      } else if (block.type === 'tool-result') {
        parts.push(...(await this.parts(block.content)))
      }
    }
    return parts
  }

  async user(message: Message): Promise<WireContentBlock[]> {
    const content: WireContentBlock[] = []
    for (const block of message.content) {
      if (block.type === 'tool-result') {
        const parts = await this.parts(block.content)
        const result: WireToolResultBlock = {
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content:
            parts.length > 0 ? parts : [{ type: 'text', text: NO_OUTPUT }],
          ...(block.isError === true ? { is_error: true } : {}),
        }
        content.push(result)
      } else {
        content.push(...(await this.parts([block])))
      }
    }
    return content
  }

  assistant(message: Message): WireContentBlock[] {
    const sameModel =
      message.source.kind === 'model' && message.source.model === this.model
    const signatures = sameModel ? thinkingSignatures(message) : undefined
    const content: WireContentBlock[] = []
    for (const [index, block] of message.content.entries()) {
      switch (block.type) {
        case 'reasoning': {
          if (!sameModel) break
          const signature = signatures?.[index]
          if (signature === undefined) {
            if (this.extras.dropUnsignedThinking === true) break
            if (block.text.length === 0) break
            this.hasUnsignedThinking = true
          }
          content.push({
            type: 'thinking',
            thinking: block.text,
            ...(signature === undefined ? {} : { signature }),
          })
          break
        }
        case 'text':
          if (block.text.length > 0)
            content.push({ type: 'text', text: block.text })
          break
        case 'tool-call':
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: parseInput(block.arguments),
          })
          break
        default:
          break
      }
    }
    return content
  }
}

function append(
  wire: WireMessage[],
  role: WireMessage['role'],
  content: WireContentBlock[],
): void {
  if (content.length === 0) return
  const last = wire.at(-1)
  if (last !== undefined && last.role === role) last.content.push(...content)
  else wire.push({ role, content })
}

/** Tool results lead their user turn (Messages requires them first). */
function resultsFirst(message: WireMessage): WireMessage {
  if (message.role !== 'user') return message
  const results = message.content.filter(
    (block) => block.type === 'tool_result',
  )
  if (results.length === 0) return message
  return {
    role: 'user',
    content: [
      ...results,
      ...message.content.filter((block) => block.type !== 'tool_result'),
    ],
  }
}

function assertImagesInUserTurns(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content))
      throw new LlmError(
        `DeepSeek accepts images in user messages only, not in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
  }
}

/** Build the full Messages request; optional fields are omitted, never null. */
export async function serializeMessagesRequest(
  options: GenerateOptions,
  defaults: MessagesRequestDefaults,
  extras: SerializeExtras = {},
): Promise<SerializedRequest> {
  assertImagesInUserTurns(options.messages)
  const messages = offloadRequestImages(
    options.messages,
    DEFAULT_REQUEST_IMAGE_BYTES,
  )
  const builder = new RequestBuilder(options.model, extras, options.signal)
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      append(wire, 'assistant', builder.assistant(message))
    } else if (message.role === 'system') {
      append(wire, 'user', await builder.parts(message.content))
    } else {
      append(wire, 'user', await builder.user(message))
    }
  }
  const tools: WireTool[] = (options.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  const body: MessagesRequest = {
    ...defaults.extraBody,
    model: options.model,
    max_tokens: options.maxTokens ?? defaults.maxTokens,
    ...(options.system !== undefined && options.system.length > 0
      ? { system: options.system }
      : {}),
    messages: wire.map(resultsFirst),
    ...(tools.length > 0 ? { tools } : {}),
    ...thinkingFields(options, defaults),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.stop === undefined || options.stop.length === 0
      ? {}
      : { stop_sequences: options.stop }),
    stream: true,
  }
  return {
    body,
    fileIds: [...new Set(builder.fileIds)],
    hasUnsignedThinking: builder.hasUnsignedThinking,
  }
}
