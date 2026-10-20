<script setup lang="ts">
/**
 * ShortcutEditor — records a keyboard shortcut: 修改 → press the new
 * combination (by physical key, with ⌃, ⌥ or ⌘) → 保存; 恢复默认 goes back
 * to the default. Esc alone cancels. A `check` that names a conflict keeps
 * 保存 disabled and shows why.
 *
 * Props:
 * - accelerator: the current Electron-style accelerator.
 * - defaultAccelerator: what 恢复默认 restores (hidden while current).
 * - busy?: disables the controls.
 * - captureLabel: accessible name of the capture box.
 * - check?: (accelerator) => conflict text, or null when it is free.
 * - showCurrent?: show the current shortcut before 修改 (the capture box
 *   takes its place while recording).
 * - testId?: prefix for `<testId>-edit` and `<testId>-capture`.
 * Emits: save(accelerator | null) — null restores the default.
 */
import { computed, nextTick, ref } from 'vue'
import Button from '../../ui/Button.vue'
import { detectShortcutPlatform } from '../../../shortcuts'
import { acceleratorFromKey, acceleratorLabel } from '../computer/shortcut'

const props = withDefaults(
  defineProps<{
    accelerator: string
    defaultAccelerator: string
    busy?: boolean
    captureLabel: string
    check?: (accelerator: string) => string | null
    showCurrent?: boolean
    testId?: string
  }>(),
  { busy: false, check: undefined, showCurrent: false, testId: undefined },
)
const emit = defineEmits<{ save: [accelerator: string | null] }>()

const mac = detectShortcutPlatform() === 'mac'
const editing = ref(false)
const captured = ref<string | null>(null)
const field = ref<HTMLElement | null>(null)
const custom = computed(
  () =>
    props.accelerator !== '' && props.accelerator !== props.defaultAccelerator,
)
const conflict = computed(() =>
  captured.value === null ? null : (props.check?.(captured.value) ?? null),
)

function idFor(part: string): string | undefined {
  return props.testId ? `${props.testId}-${part}` : undefined
}

async function start(): Promise<void> {
  captured.value = null
  editing.value = true
  await nextTick()
  field.value?.focus()
}

function cancel(): void {
  editing.value = false
  captured.value = null
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey)
    return
  event.preventDefault()
  event.stopPropagation()
  if (
    event.key === 'Escape' &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    cancel()
    return
  }
  const next = acceleratorFromKey(event, mac)
  if (next !== null) captured.value = next
}

function save(): void {
  if (captured.value === null || conflict.value !== null) return
  emit('save', captured.value)
  cancel()
}
</script>

<template>
  <div class="shortcut-editor">
    <template v-if="!editing">
      <kbd v-if="showCurrent && accelerator" class="shortcut-current">{{
        acceleratorLabel(accelerator, mac)
      }}</kbd>
      <Button
        size="sm"
        variant="secondary"
        :disabled="busy"
        :data-testid="idFor('edit')"
        @click="start"
        >修改</Button
      >
      <Button
        v-if="custom"
        size="sm"
        variant="ghost"
        :disabled="busy"
        @click="emit('save', null)"
        >恢复默认</Button
      >
    </template>
    <template v-else>
      <kbd
        ref="field"
        class="shortcut-capture"
        tabindex="0"
        role="textbox"
        :aria-label="captureLabel"
        :aria-invalid="conflict !== null || undefined"
        :data-testid="idFor('capture')"
        @keydown="onKey"
        >{{
          captured ? acceleratorLabel(captured, mac) : '按下新的组合键…'
        }}</kbd
      >
      <Button
        size="sm"
        variant="primary"
        :disabled="busy || captured === null || conflict !== null"
        @click="save"
        >保存</Button
      >
      <Button size="sm" variant="ghost" @click="cancel">取消</Button>
      <span v-if="conflict" class="shortcut-conflict" role="alert">{{
        conflict
      }}</span>
    </template>
  </div>
</template>

<style scoped>
.shortcut-editor {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.shortcut-current {
  padding: var(--space-0-5) var(--space-1-5);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-row);
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.shortcut-capture {
  min-width: calc(var(--space-4) * 6);
  padding: var(--space-0-5) var(--space-1-5);
  border: 1px solid rgb(var(--accent));
  border-radius: var(--radius-row);
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: center;
  outline: none;
}

.shortcut-capture[aria-invalid='true'] {
  border-color: rgb(var(--error));
}

.shortcut-conflict {
  flex-basis: 100%;
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: right;
}
</style>
