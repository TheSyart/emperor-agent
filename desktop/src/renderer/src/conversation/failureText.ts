// A failed model request in words the user can act on (SET-02). A
// browser-safe copy of Core's llm/failure-text.ts (this module imports core
// only as types); failureText.test.ts keeps the two identical.

export const MODEL_FAILURE_TEXT: Readonly<Record<string, string>> = {
  QUOTA:
    '模型服务的余额或额度用完了：到服务商那里充值，或在「设置 › 模型」换一个模型。',
  AUTH: '模型的 API Key 不能用了（无效、过期或没有权限）：到「设置 › 模型」检查或换一个 Key。',
  INVALID_CREDENTIAL:
    '模型的 API Key 不能用了（无效、过期或没有权限）：到「设置 › 模型」检查或换一个 Key。',
  RATE_LIMIT: '请求太频繁，被模型服务限流了：稍等一会儿再试。',
  CONTEXT_WINDOW_EXCEEDED:
    '对话太长，超出了这个模型一次能读的长度：用 /compact 压缩上下文，或开一个新对话。',
  SERVER: '模型服务暂时出错了：稍后再试；一直这样可以换一个模型。',
  LLM_STREAM_IDLE_TIMEOUT: '模型很久没有回应，已经停下：再发一次试试。',
  EMPTY_RESPONSE: '模型返回了空的回答：再发一次试试。',
}

/** The failure in Chinese; an unknown code keeps the provider's words. */
export function modelFailureText(failure: {
  code?: string
  message?: string
}): string {
  const code = failure.code ?? ''
  const known = MODEL_FAILURE_TEXT[code]
  if (known) return known
  const said = (failure.message ?? '').trim()
  if (code === 'INVALID_REQUEST')
    return said ? `模型服务拒绝了这次请求：${said}` : '模型服务拒绝了这次请求。'
  return said || code || '模型请求失败'
}
