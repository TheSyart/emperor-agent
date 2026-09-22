/**
 * Harness request-history conversion into pi-ai's Context vocabulary
 * (ported from dsh-llm-pi-ai context.ts; images resolve through the
 * attachment store and travel as inline base64).
 */

import type {
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  Tool as PiTool,
} from '@earendil-works/pi-ai'
import {
  contentHasImage,
  offloadRequestImages,
  type ImageResolver,
} from '../../content'
import { LlmError } from '../../error'
import type { Message } from '../../message'
import type { ContentBlock, GenerateOptions } from '../../types'
import { toPiAssistant } from './replay'

/** Base64 image payload bound per request before the oldest images are offloaded. */
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

function flattenText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  images: ImageResolver | undefined,
  signal: AbortSignal | undefined,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0)
          content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (images === undefined)
          throw new LlmError(
            'pi-ai image input requires the attachment store',
            'UNSUPPORTED_CONTENT',
          )
        const resolved = await images(block.attachment, signal)
        content.push({
          type: 'image',
          data: Buffer.from(resolved.data).toString('base64'),
          mimeType: resolved.mediaType,
        })
        break
      }
      case 'tool-result': {
        const nested = await userContent(block.content, images, signal)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else {
          content.push(...nested)
        }
        break
      }
      default:
        break
    }
  }
  if (content.every((block) => block.type === 'text'))
    return content.map((block) => (block as TextContent).text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is JSON Schema; pi-ai's TypeBox schema is structurally JSON Schema.
    parameters: tool.parameters as PiTool['parameters'],
  }))
}

/** Convert harness history into a pi-ai Context. Tool result names come from preceding tool calls. */
export async function toPiContext(
  options: GenerateOptions,
  images: ImageResolver | undefined,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext> {
  for (const message of options.messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
  const requestMessages = offloadRequestImages(
    options.messages,
    MAX_REQUEST_IMAGE_BYTES,
  )
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of requestMessages) {
    if (message.role === 'system') {
      // pi-ai has a single systemPrompt slot; in-history system text folds into a user turn.
      messages.push({
        role: 'user',
        content: flattenText(message),
        timestamp: 0,
      })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onReplayDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const regular = message.content.filter(
      (block) => block.type !== 'tool-result',
    )
    const results = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-result' }> =>
        block.type === 'tool-result',
    )
    const content = await userContent(regular, images, options.signal)
    if (content.length > 0 || results.length === 0)
      messages.push({ role: 'user', content, timestamp: 0 })
    for (const result of results) {
      const resultContent = await userContent(
        result.content,
        images,
        options.signal,
      )
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content:
          typeof resultContent === 'string'
            ? [{ type: 'text', text: resultContent || '(no output)' }]
            : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const tools = toolsOf(options)
  return {
    ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
  }
}
