/**
 * A failure for the CLI's version (VER-06, preview § 8): one line — why,
 * and the last good version — and the buttons: 退回 x, 装 x（已验证）,
 * 打开设置, 重新检查. Everything comes from the run's VersionFailureContext
 * (Core's health record and probe), never from an error string.
 */
import type {
  ExecutorUpgradeView,
  VersionFailureContext,
} from '@emperor/core/runtime-contract'

export interface VersionFailureButton {
  action: VersionFailureContext['actions'][number]
  label: string
  variant: 'secondary' | 'ghost'
  disabled: boolean
}

/** 「<why>。上次正常的版本：x。」 */
export function versionFailureLine(context: VersionFailureContext): string {
  const last =
    context.lastGood && context.actions.includes('rollback')
      ? `上次正常的版本：${context.lastGood}。`
      : ''
  return `${context.reason}。${last}`
}

const going = (run: ExecutorUpgradeView | null | undefined) =>
  run?.state === 'waiting' || run?.state === 'running'

/** In the order of the design; one already going holds its button. */
export function versionFailureButtons(
  context: VersionFailureContext,
  run: ExecutorUpgradeView | null | undefined,
): VersionFailureButton[] {
  const busy = going(run)
  return context.actions.map((action): VersionFailureButton => {
    if (action === 'rollback')
      return {
        action,
        label:
          busy && run?.kind === 'rollback'
            ? '正在退回…'
            : `退回 ${context.lastGood}`,
        variant: 'secondary',
        disabled: busy,
      }
    if (action === 'install_verified')
      return {
        action,
        label:
          busy && run?.kind !== 'rollback'
            ? '正在升级…'
            : `装 ${context.verifiedMax}（已验证）`,
        variant: 'secondary',
        disabled: busy,
      }
    return {
      action,
      label: action === 'recheck' ? '重新检查' : '打开设置',
      variant: 'ghost',
      disabled: false,
    }
  })
}
