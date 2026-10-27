<script setup lang="ts">
/**
 * The brand row's mode switcher (0.3 MOD-02, docs/design/modes.md § 切换):
 * the mark and 「Emperor Chat ▾」 / 「Emperor Build ▾」 / 「Emperor Group ▾」
 * (D3). `compact` (a sidebar narrower than 248px) shows the mode name only;
 * the full name is always the accessible name and, compact, the tooltip.
 *
 * The menu (ModeMenu, its own chunk fetched on the first open — MOD-05)
 * lists the three modes as `menuitemradio` rows: glyph, name, one Chinese
 * line, ⌘1–⌘3, a check on the current one, and the badges 「N 个在运行」 /
 * 「等你回答」. Enter / Space (or ↓) open it on the current mode, ↑ ↓ Home
 * End move, Enter picks, Esc closes and gives the focus back. Only
 * 「等你回答」 in another mode lights the dot on the mark; running never
 * does.
 *
 * Props: mode, activity (per mode, runtime/appMode `modeActivity`), compact.
 * Emits: select (the mode picked; the caller switches).
 */
import { computed, defineAsyncComponent, ref } from 'vue'
import {
  waitingElsewhere,
  type AppMode,
  type ModeActivity,
} from '../../runtime/appMode'
import BrandMark from '../brand/BrandMark.vue'
import { DsChevronDown } from '../icons/ds'
import Dot from '../ui/Dot.vue'
import TooltipBubble from '../ui/TooltipBubble.vue'
import { useTooltip } from '../ui/useTooltip'
import { modeEntry, modeFullName } from './modeEntries'

// Mounted only while open; it focuses the current mode once it is in.
const ModeMenu = defineAsyncComponent(() => import('./ModeMenu.vue'))

const props = withDefaults(
  defineProps<{
    mode: AppMode
    activity?: Record<AppMode, ModeActivity>
    compact?: boolean
  }>(),
  {
    activity: () => ({
      chat: { running: 0, waiting: false },
      build: { running: 0, waiting: false },
      group: { running: 0, waiting: false },
    }),
    compact: false,
  },
)
const emit = defineEmits<{ select: [mode: AppMode] }>()

const open = ref(false)
const button = ref<HTMLButtonElement | null>(null)

const fullName = computed(() => modeFullName(props.mode))
const shownName = computed(() =>
  props.compact ? modeEntry(props.mode).name : fullName.value,
)
const dot = computed(() => waitingElsewhere(props.activity, props.mode))
const label = computed(() =>
  dot.value ? `${fullName.value}，其他模式等你回答` : fullName.value,
)

const tooltip = useTooltip({
  anchor: button,
  side: () => 'bottom',
  delayMs: () => 400,
  enabled: () => props.compact && !open.value,
})

function openMenu(): void {
  tooltip.hide()
  open.value = true
}

function toggle(): void {
  if (open.value) open.value = false
  else openMenu()
}

/** MenuItem closes the menu; the focus goes back to the button. */
function select(mode: AppMode): void {
  emit('select', mode)
  button.value?.focus()
}
</script>

<template>
  <button
    ref="button"
    type="button"
    class="switcher"
    data-testid="sidebar-brand"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-label="label"
    @click="toggle"
    @keydown.down.prevent="openMenu"
    v-on="tooltip.listeners"
  >
    <span class="switcher-mark">
      <BrandMark :size="22" />
      <Dot v-if="dot" class="switcher-dot" state="attention" size="sm" />
    </span>
    <span class="switcher-name">{{ shownName }}</span>
    <DsChevronDown
      :size="14"
      class="switcher-chevron"
      :data-open="open || undefined"
    />
    <TooltipBubble
      v-if="tooltip.visible.value"
      :label="fullName"
      :side="tooltip.side.value"
      :position="tooltip.position.value"
    />
  </button>
  <ModeMenu
    v-if="open"
    v-model:open="open"
    :anchor="button"
    :mode="mode"
    :activity="activity"
    @select="select"
  />
</template>

<style scoped>
.switcher {
  position: relative;
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: var(--space-8);
  margin: 0 auto 0 calc(0px - var(--space-1));
  padding: 0 var(--space-1-5) 0 var(--space-1);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: inherit;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.switcher:hover,
.switcher[aria-expanded='true'] {
  background: var(--surface-hover);
}

.switcher:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.switcher-mark {
  position: relative;
  display: inline-flex;
  flex: none;
}

/* 「等你回答」 elsewhere: a small dot on the mark's corner, cut out of the
   sidebar fill. */
.switcher-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  box-shadow: 0 0 0 2px rgb(var(--sidebar-fill));
}

.switcher-name {
  overflow: hidden;
  font-size: var(--fs-md);
  font-weight: var(--weight-semibold);
  line-height: var(--space-6);
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switcher-chevron {
  flex: none;
  color: rgb(var(--text-3));
  transition: transform var(--motion-fast) var(--ease-standard);
}

.switcher-chevron[data-open] {
  transform: rotate(180deg);
}
</style>
