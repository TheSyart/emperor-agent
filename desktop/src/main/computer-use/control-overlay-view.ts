/** Text shown outside the trusted renderer while the Agent owns a target. */
export interface ControlOverlayTarget {
  readonly title: string
  readonly count: number
}

interface OverlayStatus {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly targets: readonly {
    readonly title: string
    readonly state: string
    readonly control: string
  }[]
}

export function selectControlOverlayTarget(
  status: OverlayStatus | null,
): ControlOverlayTarget | null {
  if (!status?.enabled || status.stopped) return null
  const controlled = status.targets.filter(
    (target) =>
      target.control === 'agent' &&
      target.state !== 'closed' &&
      target.state !== 'lost',
  )
  if (controlled.length === 0) return null
  return {
    title: controlled.at(-1)?.title.trim() || '电脑',
    count: controlled.length,
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export function controlOverlayHtml(target: ControlOverlayTarget): string {
  const title = escapeHtml(target.title)
  const suffix = target.count > 1 ? ` · 共 ${target.count} 个目标` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; background: transparent; }
    body { font: 12px -apple-system, BlinkMacSystemFont, sans-serif; color: #f9fafb; }
    .bar { display: flex; align-items: center; gap: 12px; width: 100%; height: 100%; padding: 10px 11px 10px 14px; background: #232324; border: 1px solid rgba(255,255,255,.16); border-radius: 13px; box-shadow: 0 8px 22px rgba(0,0,0,.28); }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #d6ac5c; box-shadow: 0 0 0 4px rgba(214,172,92,.13); }
    .label { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .heading { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .detail { color: #adb2b8; font-size: 11px; }
    .stop { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 55px; height: 30px; padding: 0 10px; color: #fff; text-decoration: none; font-weight: 600; border: 1px solid rgba(242,90,90,.42); border-radius: 8px; background: rgba(242,90,90,.18); }
    .stop:hover { background: rgba(242,90,90,.28); }
    .stop:focus-visible { outline: 2px solid #d6ac5c; outline-offset: 2px; }
  </style>
</head>
<body><main class="bar" aria-label="Emperor 电脑操作状态"><span class="dot" aria-hidden="true"></span><span class="label"><span class="heading">Emperor 正在操作 ${title}</span><span class="detail">随时可停止${suffix}</span></span><a class="stop" role="button" href="emperor-overlay://stop">停止</a></main></body>
</html>`
}
