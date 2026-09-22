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

export function titlePrompt(firstMessage: string): string {
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
