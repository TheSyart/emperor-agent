/**
 * Serialize harness messages into DeepSeek (OpenAI-compatible) chat
 * completions (ported from dsh-llm-deepseek serialize.ts). Text-only
 * requests keep string user content; images are sent as inline base64
 * `image_url` parts. Tool-result images follow their string-only tool
 * messages in one separate user message.
 */

import {
  contentHasImage,
  offloadRequestImages,
  type ImageResolver,
} from '../../content'
import { LlmError } from '../../error'
import type { Message } from '../../message'
import type { ContentBlock, GenerateOptions } from '../../types'
import type {
  WireImageContentPart,
  WireMessage,
  WireRequest,
  WireTool,
  WireUserContentPart,
} from './types'

/** Route-level request defaults. */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
  extraBody?: Readonly<Record<string, unknown>> | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

/** Base64 image payload bound per request before the oldest images are offloaded. */
export const MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

function reasoningEffort(effort: string): 'off' | 'low' | 'high' | 'max' {
  if (
    effort === 'off' ||
    effort === 'low' ||
    effort === 'high' ||
    effort === 'max'
  )
    return effort
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(
  options: GenerateOptions,
  defaults: RequestDefaults,
): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort =
    options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : reasoningEffort(options.reasoningEffort)
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'low' || effort === 'high' || effort === 'max')
    return { thinking: 'enabled', reasoningEffort: effort }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The DeepSeek chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => (block as { text: string }).text)
    .join('')
  const toolCalls = message.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
        block.type === 'tool-call',
    )
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    // Text-less turns send "" — never null: gateways reject null, and a
    // reasoning-only turn with null content bricks every later request.
    content: text,
    // CoT passback: required on tool-call turns in thinking mode.
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

async function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageResolver | undefined,
  signal: AbortSignal | undefined,
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0)
          parts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (images === undefined) {
          throw new LlmError(
            'DeepSeek image conversion requires the attachment store.',
            'UNSUPPORTED_CONTENT',
          )
        }
        const resolved = await images(block.attachment, signal)
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
          },
        })
        break
      }
      case 'tool-result':
        parts.push(...(await contentParts(block.content, images, signal)))
        break
      default:
        break
    }
  }
  return parts
}

function userContent(
  parts: readonly WireUserContentPart[],
): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; a mixed user message contributes its text first.
 */
export async function serializeMessages(
  messages: readonly Message[],
  images?: ImageResolver,
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [
        { type: 'text', text: TOOL_RESULT_IMAGE_TEXT },
        ...pendingToolImages,
      ],
    })
    pendingToolImages = []
  }
  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }
    const regular = message.content.filter(
      (block) => block.type !== 'tool-result',
    )
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> =>
        block.type === 'tool-result',
    )
    const content = userContent(await contentParts(regular, images, signal))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      const parts = await contentParts(result.content, images, signal)
      const imageParts = parts.filter(
        (part): part is WireImageContentPart => part.type !== 'text',
      )
      const text = parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('')
      // Empty tool output still needs SOME content on the wire.
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || '(no output)',
      })
      pendingToolImages.push(...imageParts)
    }
  }
  flushToolImages()
  return wire
}

/**
 * Build the full wire request. Always streaming with usage reporting;
 * optional fields are omitted rather than sent as null.
 */
export async function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  images?: ImageResolver,
): Promise<WireRequest> {
  const requestMessages = offloadRequestImages(
    options.messages,
    MAX_INLINE_REQUEST_IMAGE_BYTES,
  )
  const messages: WireMessage[] = []
  if (options.system !== undefined)
    messages.push({ role: 'system', content: options.system })
  messages.push(
    ...(await serializeMessages(requestMessages, images, options.signal)),
  )
  const tools: WireTool[] | undefined = options.tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const thinking = resolveThinking(options, defaults)
  return {
    ...defaults.extraBody,
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking.thinking !== undefined
      ? { thinking: { type: thinking.thinking } }
      : {}),
    ...(thinking.reasoningEffort !== undefined
      ? { reasoning_effort: thinking.reasoningEffort }
      : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}
