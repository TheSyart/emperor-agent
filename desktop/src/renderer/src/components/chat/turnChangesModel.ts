import type { TurnChangeSnapshot } from '../../types'

export function turnChangesHeadline(snapshot: TurnChangeSnapshot): string {
  const prefix = snapshot.status === 'partial' ? '已确认修改' : '修改了'
  return `${prefix} ${snapshot.filesChanged} 个文件`
}

export function turnChangesStatusText(snapshot: TurnChangeSnapshot): string {
  const prefix =
    snapshot.status === 'partial'
      ? `${snapshot.filesChanged} confirmed files`
      : `${snapshot.filesChanged} files changed`
  return `${prefix} · +${snapshot.additions} −${snapshot.deletions}`
}

export function shouldShowTurnChangesStatus(
  snapshot: TurnChangeSnapshot | null,
  busy: boolean,
): snapshot is TurnChangeSnapshot {
  return Boolean(snapshot && busy && snapshot.status === 'tracking')
}
