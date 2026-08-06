export interface MarkdownReferenceRequest {
  href: string
  label: string
  sourceMessageId: string
}

/**
 * Markdown 只负责声明引用。真正的路径归属、预览身份和可执行动作由 Core 解析，
 * ChatView 再把结果路由到 Files / Browser / Finder / 系统浏览器。
 */
export function handleMarkdownChipClick(
  event: MouseEvent,
  sourceMessageId = 'markdown',
): void {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest?.('a.md-link-chip')
  if (!(anchor instanceof HTMLAnchorElement)) return
  event.preventDefault()
  event.stopPropagation()
  const href = anchor.getAttribute('href') ?? ''
  if (!href) return
  window.dispatchEvent(
    new CustomEvent<MarkdownReferenceRequest>('emperor:resolve-reference', {
      detail: {
        href,
        label: anchor.textContent?.trim() || href,
        sourceMessageId,
      },
    }),
  )
}
