export function formatNumber(value: unknown) {
  return Number(value || 0).toLocaleString('zh-CN')
}

export function formatCompactNumber(value: unknown) {
  const number = Number(value || 0)
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 10_000) return `${Math.round(number / 1000)}K`
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`
  return String(number)
}

export function formatTokenCompact(value: unknown) {
  const parsed = Number(value || 0)
  const number = Number.isFinite(parsed) ? parsed : 0
  const sign = number < 0 ? '-' : ''
  const abs = Math.abs(number)
  if (abs < 1000) return `${number}`
  if (abs >= 1_000_000) return `${sign}${trimUnit(abs / 1_000_000)}M`
  if (abs >= 10_000) return `${sign}${trimUnit(abs / 10_000)}W`
  return `${sign}${trimUnit(abs / 1000)}K`
}

function trimUnit(value: number) {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function compactJson(value: unknown, limit = 160) {
  if (!value || typeof value !== 'object') return ''
  const text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

export function usageTypeLabel(value: string) {
  if (value === 'main_agent') return '主 Agent'
  if (value === 'memory_compaction') return '记忆压缩'
  if (value.startsWith('subagent:')) return `子代理 · ${value.split(':').slice(1).join(':')}`
  if (value === 'subagent') return '子代理'
  return value
}
