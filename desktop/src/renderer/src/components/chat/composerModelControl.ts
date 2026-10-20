/**
 * The composer's permission and model controls (UI-S04): Core's three
 * permission presets and the current one, whether Plan is on, the saved
 * model entries, the current model's label and reasoning effort, and the
 * choices that go back out through the composer's events
 * (set-permission, switch-model, set-reasoning-effort). Split out of
 * composerController.ts; PermissionChip and ModelPicker are the views.
 */
import { computed } from 'vue'
import type {
  ControlPayload,
  CurrentModelConfig,
  ModelEntry,
} from '../../types'
import {
  composerPresetOptions,
  currentComposerPermission,
  type ControlModeValue,
} from './composerControls'

export interface ComposerModelControlProps {
  busy: boolean
  control?: ControlPayload | null
  currentModel?: CurrentModelConfig | null
  modelEntries: ModelEntry[]
}

export interface ComposerModelControlEmit {
  (event: 'set-permission', mode: ControlModeValue): void
  (event: 'switch-model', entryId: string): void
  (event: 'set-reasoning-effort', level: string | null): void
}

export function useComposerModelControl(
  props: Readonly<ComposerModelControlProps>,
  emit: ComposerModelControlEmit,
  focusInput: () => void,
) {
  const modeOptions = computed(() => composerPresetOptions(props.control))
  const currentMode = computed(() => {
    const option = currentComposerPermission(props.control)
    return (
      modeOptions.value.find((item) => item.value === option.value) ??
      modeOptions.value[1]!
    )
  })
  const modeTitle = computed(() =>
    props.busy ? '等待当前任务结束后再切换' : '切换执行权限',
  )
  /** Plan is on: the preset applies once the plan is approved. */
  const planEnabled = computed(() => props.control?.plan === true)

  const availableModelEntries = computed(() =>
    props.modelEntries.filter((entry) => entry.entryId),
  )
  const activeModelId = computed(
    () => props.currentModel?.entryId || props.modelEntries[0]?.entryId || '',
  )
  const currentModelEntry = computed(
    () =>
      availableModelEntries.value.find(
        (entry) => entry.entryId === activeModelId.value,
      ) ??
      availableModelEntries.value[0] ??
      null,
  )
  const showModelSwitcher = computed(
    () => availableModelEntries.value.length > 0,
  )
  const currentModelLabel = computed(
    () =>
      currentModelEntry.value?.effectiveDisplayName ||
      currentModelEntry.value?.modelId ||
      props.currentModel?.effectiveDisplayName ||
      props.currentModel?.modelId ||
      '模型',
  )
  const currentReasoningValue = computed(() =>
    normalizeReasoningValue(
      props.currentModel?.reasoningEffort ??
        currentModelEntry.value?.reasoningEffort ??
        null,
    ),
  )
  const currentReasoningLabel = computed(() =>
    reasoningLabel(currentReasoningValue.value),
  )
  const modelTitle = computed(() =>
    props.busy
      ? '等待当前任务结束后再切换模型'
      : `${currentModelLabel.value} · 思考 ${currentReasoningLabel.value}`,
  )
  const reasoningOptions = computed(() => [
    { value: null, label: 'Default' },
    ...(props.currentModel?.reasoningEfforts || []).map((option) => ({
      value: option,
      label: reasoningLabel(option),
    })),
  ])

  function selectMode(mode: ControlModeValue): void {
    if (props.busy) return
    if (mode !== currentMode.value.value) emit('set-permission', mode)
    focusInput()
  }

  function selectModel(entryId: string): void {
    if (props.busy) return
    if (entryId !== activeModelId.value) emit('switch-model', entryId)
    focusInput()
  }

  function selectReasoning(value: string | null): void {
    if (props.busy) return
    const next = normalizeReasoningValue(value) || null
    if ((currentReasoningValue.value || '') !== (next || ''))
      emit('set-reasoning-effort', next)
  }

  return {
    modeOptions,
    currentMode,
    modeTitle,
    planEnabled,
    activeModelId,
    showModelSwitcher,
    currentModelLabel,
    currentReasoningValue,
    currentReasoningLabel,
    modelTitle,
    reasoningOptions,
    selectMode,
    selectModel,
    selectReasoning,
  }
}

export function normalizeReasoningValue(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

export function reasoningLabel(value?: string | null): string {
  const normalized = normalizeReasoningValue(value)
  if (!normalized) return 'Default'
  if (normalized === 'max') return 'Max'
  if (normalized === 'xhigh') return 'XHigh'
  if (normalized === 'high') return 'High'
  if (normalized === 'medium') return 'Medium'
  if (normalized === 'low') return 'Low'
  if (normalized === 'minimal') return 'Minimal'
  if (normalized === 'none') return 'None'
  return normalized
}
