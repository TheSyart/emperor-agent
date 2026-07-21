export function composerSendDisabled(opts: {
  busy: boolean
  content: string
  attachmentCount: number
  sendBlockedReason?: string | null
}): boolean {
  if (opts.busy) return !opts.content.trim() && opts.attachmentCount === 0
  if (opts.sendBlockedReason) return true
  return !opts.content.trim() && opts.attachmentCount === 0
}

export function composerStopPresentation(goalActive: boolean) {
  return goalActive
    ? {
        title: '暂停当前 Goal',
        label: '暂停 Goal',
      }
    : {
        title: '停止当前任务',
        label: '停止',
      }
}

export type ControlModeValue = 'ask_before_edit' | 'smart_auto' | 'full_access'

export interface ComposerControlProjection {
  mode?: string | null
  previous_mode?: ControlModeValue | null
}

export interface ComposerModeOption {
  value: ControlModeValue
  label: string
  short: string
  description: string
}

export const composerModeOptions: ComposerModeOption[] = [
  {
    value: 'ask_before_edit',
    label: '询问确认',
    short: '询问',
    description: '只读操作直接执行；编辑、Shell 与外部写入先确认',
  },
  {
    value: 'smart_auto',
    label: '智能自动',
    short: '智能',
    description: '自动执行本地安全操作，高影响和不确定操作先确认',
  },
  {
    value: 'full_access',
    label: '完全访问',
    short: '完全',
    description: '不再请求普通权限，但仍遵守明确拒绝和系统边界',
  },
]

export function normalizeComposerControlMode(
  mode: string | null | undefined,
): ControlModeValue {
  if (mode === 'normal' || !mode) return 'ask_before_edit'
  if (mode === 'smart_auto' || mode === 'accept_edits') return 'smart_auto'
  if (mode === 'full_access' || mode === 'auto') return 'full_access'
  return 'ask_before_edit'
}

export function currentComposerMode(
  mode: string | null | undefined,
): ComposerModeOption {
  const normalized = normalizeComposerControlMode(mode)
  return (
    composerModeOptions.find((item) => item.value === normalized) ??
    composerModeOptions[0]!
  )
}

export function currentComposerPermission(
  control: ComposerControlProjection | null | undefined,
): ComposerModeOption {
  const permission =
    control?.mode === 'plan' ? control.previous_mode : control?.mode
  return currentComposerMode(permission)
}
