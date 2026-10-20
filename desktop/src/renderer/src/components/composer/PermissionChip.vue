<script setup lang="ts">
/**
 * PermissionChip — the composer's permission control (UI-S04): a 28px chip
 * with the preset's shield glyph (只读 check / 工作区可写 edit / 完全访问
 * alert) and its short name, plus 「· Plan」 while Plan 模式 is on. The
 * upward menu lists Core's three presets (`control.presets`) and ends with
 * the Plan 模式 switch: Plan makes the agent explore read-only and submit a
 * plan before it acts; the preset applies once the plan is approved.
 *
 * Props: options, current, plan (Plan 模式 is on), disabled?, title?.
 * Emits: select(preset), plan(on).
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
import Switch from '../ui/Switch.vue'

const props = defineProps<{
  options: ComposerModeOption[]
  current: ComposerModeOption
  plan: boolean
  disabled?: boolean
  title?: string
}>()

const emit = defineEmits<{
  select: [mode: ControlModeValue]
  plan: [on: boolean]
}>()

const open = ref(false)
const anchor = ref<HTMLElement | null>(null)

const icons = {
  'read-only': DsShieldCheck,
  'workspace-write': DsShieldEdit,
  'danger-full-access': DsShieldAlert,
} as const

const currentIcon = computed(() => icons[props.current.value])
const label = computed(
  () => `执行权限 · ${props.current.label}${props.plan ? ' · Plan 模式' : ''}`,
)

function select(mode: ControlModeValue): void {
  open.value = false
  if (mode !== props.current.value) emit('select', mode)
}

/** The switch (or its row) flips Plan; the menu stays open to show it. */
function togglePlan(): void {
  emit('plan', !props.plan)
}
</script>

<template>
  <span ref="anchor" class="permission-chip">
    <Chip
      chevron
      :active="open"
      :disabled="disabled"
      :title="title || '切换执行权限'"
      :aria-label="label"
      :aria-expanded="open"
      aria-haspopup="menu"
      :data-preset="current.value"
      @click="open = !open"
    >
      <template #icon><component :is="currentIcon" :size="14" /></template>
      <span class="label">{{ current.short }}</span>
      <span v-if="plan" class="plan">&nbsp;· Plan</span>
    </Chip>
  </span>
  <Menu v-model:open="open" :anchor="anchor" :width="280" label="执行权限">
    <MenuItem variant="label">
      执行权限 · {{ plan ? '规划结束后使用' : '立即应用到下一轮' }}
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
    <template #footer>
      <div class="plan-row">
        <span class="plan-text" @click="togglePlan">
          <span class="plan-title">Plan 模式</span>
          <span class="plan-description">先规划，确认后再执行</span>
        </span>
        <Switch
          :model-value="plan"
          aria-label="Plan 模式"
          @change="togglePlan"
        />
      </div>
    </template>
  </Menu>
</template>

<style scoped>
.permission-chip {
  display: inline-flex;
  min-width: 0;
}

.permission-chip :deep([data-preset='danger-full-access']) {
  color: rgb(var(--attention));
}

.plan {
  color: rgb(var(--text-1));
}

.plan-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2-5);
}

.plan-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  cursor: pointer;
}

.plan-title {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--text-1));
}

.plan-description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

@container (max-width: 460px) {
  .label,
  .plan {
    display: none;
  }
}
</style>
