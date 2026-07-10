import type { ModelRouter, ProviderSnapshot } from '../model/router'

const FORBIDDEN_PREFIXES = [
  '关于',
  '帮我',
  '如何',
  '请',
  '实现',
  '优化',
  '处理',
  '完成',
  '给我',
]
const PUNCT_RE =
  /[`~!@#$%^&*()_=+[\]{}\\|;:'",.<>/?，。！？、；：“”‘’（）【】《》「」『』…—-]+/g
const SPACE_RE = /\s+/g

export class SessionTitleService {
  readonly modelRouter: Pick<ModelRouter, 'route'>

  constructor(modelRouter: Pick<ModelRouter, 'route'>) {
    this.modelRouter = modelRouter
  }

  async generate(firstMessage: string): Promise<string> {
    const fallback = fallbackSessionTitle(firstMessage)
    const prompt = titlePrompt(firstMessage)
    const route = this.modelRouter.route('session_title', null, firstMessage)
    const snapshots = [route.snapshot, route.fallback].filter(
      Boolean,
    ) as ProviderSnapshot[]
    for (const snapshot of snapshots) {
      try {
        const generation = snapshot.generation
        const response = await snapshot.provider.chat({
          messages: [
            {
              role: 'system',
              content:
                '你只负责给聊天会话命名。必须只输出标题本身，不要解释，不要标点，不要换行。',
            },
            { role: 'user', content: prompt },
          ],
          tools: null,
          model: snapshot.model,
          maxTokens: Math.min(64, Number(generation.maxTokens || 64)),
          temperature: 0.1,
          reasoningEffort: generation.reasoningEffort,
        })
        const title = sanitizeSessionTitle(response.content || '')
        if (title) return title
      } catch {
        continue
      }
    }
    return fallback
  }
}

export function sanitizeSessionTitle(value: string): string {
  let text = String(value || '').trim()
  text = text
    .replace(/^```[a-zA-Z0-9_-]*/, '')
    .replace(/```$/, '')
    .trim()
  text = text.replace(/\n/g, ' ')
  text = text.split(/[,，。.!！？?；;:：]/, 1)[0] ?? ''
  text = text.replace(PUNCT_RE, ' ')
  text = text.replace(SPACE_RE, ' ').trim()
  text = stripForbiddenPrefixes(text)
  text = text.replace(SPACE_RE, ' ').trim()
  if (!text) return ''
  text = truncateTitle(text)
  return visibleLen(text) >= 2 ? text : ''
}

export function fallbackSessionTitle(firstMessage: string): string {
  return sanitizeSessionTitle(firstMessage) || '新会话'
}

function titlePrompt(firstMessage: string): string {
  return (
    '根据下面第一条用户消息生成会话标题。\n' +
    '规则：2-12 个中文字符，或非常简短的中英混合任务名；' +
    '不要标点、引号、emoji；不要使用 关于、帮我、如何、请、实现、优化 等套话；' +
    '只输出标题。\n\n' +
    `用户消息：${firstMessage.slice(0, 1200)}`
  )
}

function stripForbiddenPrefixes(text: string): string {
  let out = text
  let changed = true
  while (changed) {
    changed = false
    const stripped = out.trimStart()
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (!stripped.startsWith(prefix)) continue
      out = stripped.slice(prefix.length).trimStart()
      changed = true
      break
    }
  }
  return out.trim()
}

function truncateTitle(text: string, limit = 12): string {
  if (visibleLen(text) <= limit) return text
  let count = 0
  const chars: string[] = []
  for (const ch of text) {
    count += 1
    if (count > limit) break
    chars.push(ch)
  }
  return chars.join('').trim()
}

function visibleLen(text: string): number {
  return text.replace(/ /g, '').length
}
