<script setup lang="ts">
/**
 * Popover — an anchored panel on the menu surface (DS-05): radius 12,
 * menu fill, lv3 shadow, a labelled non-modal dialog. Placed like ui/Menu
 * (chat/floatingMenu): below the anchor by default, flipping when cramped,
 * right edges aligned. A press or focus outside the anchor and panel
 * closes it; Escape closes it from anywhere (capture phase, so a popover
 * inside a dialog closes before the dialog) and gives focus back to the
 * anchor.
 *
 * Props:
 * - open (v-model:open).
 * - anchor: the trigger element.
 * - label: accessible name of the panel.
 * - width (default 320): panel width in px.
 * - placement: 'bottom' (default) or 'top'.
 * - padded (default true): 12px inner padding; false for list content
 *   that pads its own rows.
 * Slot: default (panel content). Attributes (class, data-*) land on the
 * panel. The panel element is exposed as `panel` so content can park focus
 * on it (tabindex -1).
 */
import { nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { useFloatingMenu } from '../chat/floatingMenu'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    anchor: HTMLElement | null
    label: string
    width?: number
    placement?: 'top' | 'bottom'
    padded?: boolean
  }>(),
  { width: 320, placement: 'bottom', padded: true },
)

const open = defineModel<boolean>('open', { default: false })
const panel = ref<HTMLElement | null>(null)

function close(): void {
  open.value = false
}

const floating = useFloatingMenu({
  open,
  button: toRef(props, 'anchor'),
  menu: panel,
  fallbackWidth: props.width,
  fallbackHeight: 240,
  onClose: close,
  prefer: () => props.placement,
})

// Escape closes the popover wherever focus is (a control that disabled
// itself drops focus to <body>, where a listener on the panel would not
// hear the key).
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing)
    return
  event.preventDefault()
  event.stopPropagation()
  close()
  props.anchor?.focus({ preventScroll: true })
}

function detach(): void {
  document.removeEventListener('keydown', onDocumentKeydown, true)
  floating.removeListeners()
}

watch(
  open,
  async (value) => {
    if (typeof document === 'undefined') return
    if (!value) {
      detach()
      return
    }
    document.addEventListener('keydown', onDocumentKeydown, true)
    await nextTick()
    floating.position()
    floating.addListeners()
  },
  { immediate: true },
)

onBeforeUnmount(detach)

defineExpose({ panel })
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      v-bind="$attrs"
      ref="panel"
      class="ds-popover ds-fade-in"
      role="dialog"
      :aria-label="label"
      tabindex="-1"
      :data-padded="padded || undefined"
      :style="{ width: `${width}px`, ...floating.style.value }"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.ds-popover {
  position: fixed;
  z-index: var(--z-menu);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: var(--space-1);
  overflow-y: auto;
  border: 1px solid var(--border-inverted);
  border-radius: var(--radius-card);
  background: rgb(var(--menu-fill));
  box-shadow: var(--shadow-lv3);
  color: rgb(var(--label-primary));
}

.ds-popover[data-padded] {
  padding: var(--space-3);
}

/* Focus only parks on the panel after an action; it is not a control. */
.ds-popover:focus {
  outline: none;
}
</style>
