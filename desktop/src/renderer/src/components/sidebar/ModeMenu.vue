<script setup lang="ts">
/**
 * The mode switcher's open menu (0.3 MOD-02; its own chunk since MOD-05,
 * fetched on the first open so it stays out of the start-up bundle). It is
 * mounted only while open: ui/Menu with the three modes as `menuitemradio`
 * rows — glyph, name, one Chinese line, ⌘1–⌘3, a check on the current one,
 * and the badges 「N 个在运行」 / 「等你回答」.
 *
 * Keyboard: mounting puts the focus on the current mode; ↑ ↓ Home End move;
 * Enter picks (MenuItem closes the menu); Esc closes and gives the focus
 * back to the anchor (ui/Menu).
 *
 * Props: open (v-model), anchor (the switcher button), mode, activity.
 * Emits: select (the mode picked; ModeSwitcher passes it on).
 */
import { nextTick, onMounted, ref } from 'vue'
import type { AppMode, ModeActivity } from '../../runtime/appMode'
import { detectShortcutPlatform, shortcutLabel } from '../../shortcuts'
import Badge from '../ui/Badge.vue'
import Kbd from '../ui/Kbd.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import { MODE_ENTRIES } from './modeEntries'

defineProps<{
  anchor: HTMLElement | null
  mode: AppMode
  activity: Record<AppMode, ModeActivity>
}>()
const emit = defineEmits<{ select: [mode: AppMode] }>()
const open = defineModel<boolean>('open', { default: false })

const list = ref<HTMLElement | null>(null)
const platform = detectShortcutPlatform()

function items(): HTMLElement[] {
  return [
    ...(list.value?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ??
      []),
  ]
}

onMounted(async () => {
  await nextTick()
  const all = items()
  ;(
    all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0]
  )?.focus()
})

function onKeydown(event: KeyboardEvent): void {
  const all = items()
  if (!all.length) return
  const at = all.indexOf(document.activeElement as HTMLElement)
  const last = all.length - 1
  let next: number
  if (event.key === 'ArrowDown') next = at < 0 || at === last ? 0 : at + 1
  else if (event.key === 'ArrowUp') next = at <= 0 ? last : at - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  else return
  event.preventDefault()
  all[next]!.focus()
}

function shortcut(action: (typeof MODE_ENTRIES)[number]['shortcut']): string {
  return shortcutLabel(action, platform)
}
</script>

<template>
  <Menu
    v-model:open="open"
    :anchor="anchor"
    :width="340"
    placement="bottom"
    align="start"
    label="切换模式"
  >
    <div ref="list" class="mode-items" @keydown="onKeydown">
      <MenuItem
        v-for="entry in MODE_ENTRIES"
        :key="entry.mode"
        radio
        :selected="entry.mode === mode"
        :description="entry.description"
        :data-mode="entry.mode"
        @select="emit('select', entry.mode)"
      >
        <template #icon><component :is="entry.icon" :size="16" /></template>
        <span class="mode-label">
          <span class="mode-name">{{ entry.name }}</span>
          <Badge
            v-if="activity[entry.mode].running"
            tone="info"
            :label="`${activity[entry.mode].running} 个在运行`"
          />
          <Badge
            v-if="activity[entry.mode].waiting"
            tone="attention"
            label="等你回答"
          />
        </span>
        <template #trailing>
          <Kbd class="mode-key">{{ shortcut(entry.shortcut) }}</Kbd>
        </template>
      </MenuItem>
    </div>
  </Menu>
</template>

<style scoped>
.mode-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 100%;
}

.mode-name {
  font-weight: var(--weight-medium);
}

.mode-key {
  flex: none;
  align-self: flex-start;
  font-size: var(--fs-xxs);
  line-height: var(--lh-s);
  color: rgb(var(--text-3));
}
</style>
