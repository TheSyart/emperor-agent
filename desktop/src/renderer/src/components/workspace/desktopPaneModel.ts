import type { UiTargetView } from '@emperor/core/runtime-contract'

export type DesktopTargetAction =
  'pause' | 'resume' | 'takeover' | 'handback' | 'close'

const LIVE_STATES = new Set<UiTargetView['state']>([
  'created',
  'attached',
  'paused',
  'recovering',
])

export function desktopTargetsFor(
  targets: readonly UiTargetView[],
  sessionId: string | null | undefined,
): UiTargetView[] {
  if (!sessionId) return []
  return targets.filter(
    (target) =>
      target.driver === 'desktop' &&
      target.ownerSessionId === sessionId &&
      LIVE_STATES.has(target.state),
  )
}

export function desktopTargetActions(
  control: UiTargetView['control'],
): DesktopTargetAction[] {
  switch (control) {
    case 'agent':
      return ['pause', 'takeover', 'close']
    case 'paused':
      return ['resume', 'takeover', 'close']
    case 'user-takeover':
      return ['handback', 'close']
    case 'stopped':
      return ['takeover', 'close']
  }
}

export function desktopControlLabel(target: UiTargetView): string {
  if (target.control === 'stopped') return '已急停'
  if (target.control === 'user-takeover') return '你已接管'
  if (target.control === 'paused') return '已暂停'
  if (target.state === 'recovering') return '正在恢复'
  return 'Agent 操作中'
}

export function desktopAppId(target: UiTargetView): string {
  return target.url.startsWith('app:') ? target.url.slice(4) : target.url
}

/** Windows that get a live preview: those the Agent controls, at most four. */
export function desktopLiveTargetIds(
  targets: readonly UiTargetView[],
  stopped: boolean,
): string[] {
  if (stopped) return []
  return targets
    .filter((target) => target.control === 'agent')
    .slice(0, 4)
    .map((target) => target.targetId)
}

/** The line under a window's picture: what it shows and why. */
export function desktopPreviewNote(
  target: UiTargetView,
  live: boolean,
  stopped: boolean,
): string {
  if (stopped || target.control !== 'agent')
    return live ? '实时预览已暂停，显示最后一帧' : '实时预览已暂停'
  return live
    ? '实时画面。菜单栏的「停止共享」等同于接管'
    : '等待实时画面（敏感应用和代填凭据后的窗口不显示）'
}
