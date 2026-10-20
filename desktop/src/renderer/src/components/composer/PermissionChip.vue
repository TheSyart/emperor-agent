<script setup lang="ts">
/**
 * PermissionChip — dsh PermissionSelect: 28px chip with the preset's shield
 * glyph (只读 check / 工作区可写 edit / 完全访问 alert) opening an upward
 * menu of Core's three presets (`control.presets`).
 */
import { computed, ref } from 'vue'
import type {
  ComposerModeOption,
  ControlModeValue,
} from '../chat/composerControls'
import { DsShieldAlert, DsShieldCheck, DsShieldEdit } from '../icons/ds'
import Chip from '../ui/Chip.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'

const props = defineProps<{
  options: ComposerModeOption[]
  current: ComposerModeOption
  disabled?: boolean
  afterPlan?: boolean
  title?: string
}>()

const emit = defineEmits<{ select: [mode: ControlModeValue] }>()

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)

const icons = {
  'read-only': DsShieldCheck,
  'workspace-write': DsShieldEdit,
  'danger-full-access': DsShieldAlert,
} as const

const currentIcon = computed(() => icons[props.current.value])

function select(mode: ControlModeValue): void {
  open.value = false
  if (mode !== props.current.value) emit('select', mode)
}
</script>

<template>
  <span ref="anchor" class="permission-chip">
    <Chip
      chevron
      :active="open"
      :disabled="disabled"
      :title="title || '切换执行权限'"
      :aria-expanded="open"
      aria-haspopup="menu"
      :data-preset="current.value"
      @click="open = !open"
    >
      <template #icon><component :is="currentIcon" :size="14" /></template>
      <span class="label">{{ current.short }}</span>
    </Chip>
  </span>
  <Menu v-model:open="open" :anchor="anchor" :width="280" label="执行权限">
    <MenuItem variant="label">
      执行权限 · {{ afterPlan ? '规划结束后使用' : '立即应用到下一轮' }}
    </MenuItem>
    <MenuItem
      v-for="option in options"
      :key="option.value"
      :selected="option.value === current.value"
      :description="option.description"
      @select="select(option.value)"
    >
      <template #icon
        ><component :is="icons[option.value]" :size="16"
      /></template>
      {{ option.label }}
    </MenuItem>
  </Menu>
</template>

<style scoped>
.permission-chip {
  display: inline-flex;
  min-width: 0;
}

.permission-chip :deep([data-preset='danger-full-access']) {
  color: rgb(var(--approval-line));
}

@container (max-width: 460px) {
  .label {
    display: none;
  }
}
</style>
