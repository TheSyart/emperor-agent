<script setup lang="ts">
/**
 * KillSwitchEditor — changes the emergency-stop shortcut (spec 00 §6.6):
 * 修改 → press the new combination (by physical key) → 保存; 恢复默认 goes
 * back to the platform default. Esc alone cancels.
 *
 * Props: accelerator (current), busy.
 * Emits: save(accelerator | null) — null restores the default.
 */
import { computed, nextTick, ref } from 'vue'
import Button from '../../ui/Button.vue'
import { detectShortcutPlatform } from '../../../shortcuts'
import {
  acceleratorFromKey,
  acceleratorLabel,
  defaultKillSwitchAccelerator,
} from './shortcut'

const props = defineProps<{ accelerator: string; busy: boolean }>()
const emit = defineEmits<{ save: [accelerator: string | null] }>()

const mac = detectShortcutPlatform() === 'mac'
const editing = ref(false)
const captured = ref<string | null>(null)
const field = ref<HTMLElement | null>(null)
const custom = computed(
  () =>
    props.accelerator !== '' &&
    props.accelerator !== defaultKillSwitchAccelerator(mac),
)

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
  if (captured.value === null) return
  emit('save', captured.value)
  cancel()
}
</script>

<template>
  <div class="ks-editor">
    <template v-if="!editing">
      <Button
        size="sm"
        variant="outline"
        :disabled="busy"
        data-testid="kill-switch-edit"
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
        class="ks-capture"
        tabindex="0"
        role="textbox"
        aria-label="按下新的停止快捷键"
        data-testid="kill-switch-capture"
        @keydown="onKey"
        >{{
          captured ? acceleratorLabel(captured, mac) : '按下新的组合键…'
        }}</kbd
      >
      <Button
        size="sm"
        variant="primary"
        :disabled="busy || captured === null"
        @click="save"
        >保存</Button
      >
      <Button size="sm" variant="ghost" @click="cancel">取消</Button>
    </template>
  </div>
</template>

<style scoped>
.ks-editor {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.ks-capture {
  min-width: calc(var(--space-4) * 6);
  padding: var(--space-0-5) var(--space-1-5);
  border: 1px solid rgb(var(--accent));
  border-radius: var(--radius-row);
  color: rgb(var(--label-primary));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: center;
  outline: none;
}
</style>
