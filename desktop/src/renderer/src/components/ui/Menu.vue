<script setup lang="ts">
/**
 * Menu — dsh popover menu (radius 12, 4px inset, menu-fill, lv3 shadow).
 * Anchored to `anchor` and placed above it when there is room (upward
 * composer menus), otherwise below; right edges align. Positioning,
 * outside-click and focus-out dismissal reuse chat/floatingMenu.ts.
 *
 * Props:
 * - open (v-model:open).
 * - anchor: the trigger element (HTMLElement | null).
 * - width (default 218): fallback width before first measure.
 * - dense?: 34px rows instead of 40px.
 * - label?: aria-label for the menu.
 * - placement?: preferred side, 'top' (default, composer menus) or
 *   'bottom' (dropdowns such as the settings Select); flips when cramped.
 * Slots: default (MenuItem children), `footer` (hairline-separated block).
 */
import {
  nextTick,
  onBeforeUnmount,
  provide,
  reactive,
  ref,
  toRef,
  watch,
} from 'vue'
import { useFloatingMenu } from '../chat/floatingMenu'
import { MENU_CONTEXT } from './menuContext'

const props = withDefaults(
  defineProps<{
    anchor: HTMLElement | null
    width?: number
    dense?: boolean
    label?: string
    placement?: 'top' | 'bottom'
  }>(),
  { width: 218, dense: false, label: undefined, placement: 'top' },
)

const open = defineModel<boolean>('open', { default: false })
const menu = ref<HTMLElement | null>(null)

function close() {
  open.value = false
}

const floating = useFloatingMenu({
  open,
  button: toRef(props, 'anchor'),
  menu,
  fallbackWidth: props.width,
  fallbackHeight: 240,
  onClose: close,
  prefer: () => props.placement,
})

provide(MENU_CONTEXT, reactive({ close, dense: toRef(props, 'dense') }))

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    props.anchor?.focus()
  }
}

// A menu whose content changes while open (a drill-down pane, a filtered
// list) is re-placed as its height changes, so an upward menu keeps its
// bottom edge on the trigger instead of growing off-screen.
let resizeObserver: ResizeObserver | null = null

function stopObserving() {
  resizeObserver?.disconnect()
  resizeObserver = null
}

watch(
  open,
  async (value) => {
    if (!value) {
      floating.removeListeners()
      stopObserving()
      return
    }
    await nextTick()
    floating.position()
    floating.addListeners()
    if (menu.value && typeof ResizeObserver !== 'undefined') {
      stopObserving()
      resizeObserver = new ResizeObserver(() => floating.position())
      resizeObserver.observe(menu.value)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  floating.removeListeners()
  stopObserving()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="ds-menu ds-fade-in"
      role="menu"
      :aria-label="label"
      :data-dense="dense || undefined"
      :data-placement="floating.placement.value"
      :style="{ ...floating.style.value, minWidth: `${width}px` }"
      @keydown="onKeydown"
    >
      <div class="viewport"><slot /></div>
      <div v-if="$slots.footer" class="footer"><slot name="footer" /></div>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-menu {
  position: fixed;
  z-index: var(--z-menu);
  display: flex;
  flex-direction: column;
  max-width: 360px;
  padding: var(--space-1);
  border: 1px solid var(--border-inverted);
  border-radius: var(--radius-card);
  background: rgb(var(--menu-fill));
  box-shadow: var(--shadow-lv3);
}

.viewport {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.footer {
  display: flex;
  flex: none;
  flex-direction: column;
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--border-l2);
}
</style>
