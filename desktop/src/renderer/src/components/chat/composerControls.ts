export function composerSendDisabled(opts: {
  busy: boolean
  content: string
  attachmentCount: number
  queueOccupied?: boolean
  sendBlockedReason?: string | null
}): boolean {
  if (opts.busy) {
    if (opts.queueOccupied) return true
    return !opts.content.trim() && opts.attachmentCount === 0
  }
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

export type ControlModeValue =
  'read-only' | 'workspace-write' | 'danger-full-access'

export interface ComposerControlProjection {
  preset?: string | null
  mode?: string | null
  plan?: boolean
  presets?: Array<{ value: string; name: string; description: string }>
}

export interface ComposerModeOption {
  value: ControlModeValue
  label: string
  short: string
  description: string
}

export const composerModeOptions: ComposerModeOption[] = [
  {
    value: 'read-only',
    label: '只读',
    short: '只读',
    description: '沙箱只读；写入与命令越权先确认',
  },
  {
    value: 'workspace-write',
    label: '工作区可写',
    short: '工作区',
    description: '可读写当前工作区；越出沙箱的操作先确认',
  },
  {
    value: 'danger-full-access',
    label: '完全访问',
    short: '完全',
    description: '不启用沙箱且免询问；请仅在可信任务中使用',
  },
]

const PRESET_VALUES = new Set<string>(
  composerModeOptions.map((option) => option.value),
)

export function normalizeComposerControlMode(
  mode: string | null | undefined,
): ControlModeValue {
  return PRESET_VALUES.has(String(mode || ''))
    ? (mode as ControlModeValue)
    : 'workspace-write'
}

/** Preset options, preferring Core's names/descriptions from `control.presets`. */
export function composerPresetOptions(
  control: ComposerControlProjection | null | undefined,
): ComposerModeOption[] {
  const fromCore = new Map(
    (control?.presets || []).map((preset) => [preset.value, preset]),
  )
  return composerModeOptions.map((option) => {
    const core = fromCore.get(option.value)
    return core
      ? {
          ...option,
          label: core.name || option.label,
          description: core.description || option.description,
        }
      : option
  })
}

export function currentComposerMode(
  mode: string | null | undefined,
): ComposerModeOption {
  const normalized = normalizeComposerControlMode(mode)
  return (
    composerModeOptions.find((item) => item.value === normalized) ??
    composerModeOptions[1]!
  )
}

export function currentComposerPermission(
  control: ComposerControlProjection | null | undefined,
): ComposerModeOption {
  return currentComposerMode(control?.preset ?? control?.mode)
}
