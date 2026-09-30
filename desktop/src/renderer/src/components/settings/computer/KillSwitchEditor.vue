<script setup lang="ts">
/**
 * KillSwitchEditor — changes the emergency-stop shortcut (spec 00 §6.6)
 * with the settings ShortcutEditor; 恢复默认 goes back to the platform
 * default.
 *
 * Props: accelerator (current), busy.
 * Emits: save(accelerator | null) — null restores the default.
 */
import ShortcutEditor from '../ui/ShortcutEditor.vue'
import { detectShortcutPlatform } from '../../../shortcuts'
import { defaultKillSwitchAccelerator } from './shortcut'

defineProps<{ accelerator: string; busy: boolean }>()
const emit = defineEmits<{ save: [accelerator: string | null] }>()

const mac = detectShortcutPlatform() === 'mac'
</script>

<template>
  <ShortcutEditor
    :accelerator="accelerator"
    :default-accelerator="defaultKillSwitchAccelerator(mac)"
    :busy="busy"
    capture-label="按下新的停止快捷键"
    test-id="kill-switch"
    @save="emit('save', $event)"
  />
</template>
