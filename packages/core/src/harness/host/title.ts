/** One-shot session titles through the LLM client (`purpose: 'session-title'`). */

import type { LlmClient } from '../../llm/client'
import { createUserMessage } from '../../llm/message'
import {
  fallbackSessionTitle,
  sanitizeSessionTitle,
  titlePrompt,
} from '../../sessions/title'

const TITLE_SYSTEM =
  '你只负责给聊天会话命名。必须只输出标题本身，不要解释，不要标点，不要换行。'

export async function generateSessionTitle(
  llm: LlmClient,
  firstMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = fallbackSessionTitle(firstMessage)
  try {
    const base = llm.defaultCallConfig()
    const result = await llm.complete({
      provider: base.provider,
      model: base.model,
      system: TITLE_SYSTEM,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: titlePrompt(firstMessage) }],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: 64,
      temperature: 0.1,
      purpose: 'session-title',
      ...(signal === undefined ? {} : { signal }),
    })
    return sanitizeSessionTitle(result.text) || fallback
  } catch {
    return fallback
  }
}
