<script setup lang="ts">
/** The teleported bubble of a tooltip (13/20 on --tooltip-bg, radius 8). */
import Kbd from './Kbd.vue'
import type { TooltipSide } from './useTooltip'

defineProps<{
  label: string
  shortcut?: string
  side: TooltipSide
  position: { left: string; top: string }
}>()
</script>

<template>
  <Teleport to="body">
    <div
      class="ds-tooltip ds-fade-in"
      role="tooltip"
      :data-side="side"
      :style="position"
    >
      {{ label
      }}<Kbd v-if="shortcut" class="ds-tooltip-shortcut">{{ shortcut }}</Kbd>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-tooltip {
  position: fixed;
  z-index: var(--z-lightbox);
  width: max-content;
  max-width: 50vw;
  padding: calc(var(--space-1) - 1px) calc(var(--space-2) - 1px);
  border-radius: var(--radius-row);
  background: rgb(var(--tooltip-bg));
  color: rgb(var(--tooltip-fg));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  white-space: pre-line;
  overflow-wrap: break-word;
  pointer-events: none;
}

.ds-tooltip-shortcut {
  margin-left: var(--space-1-5);
  opacity: 0.7;
}

.ds-tooltip[data-side='top'] {
  transform: translate(-50%, -100%);
}

.ds-tooltip[data-side='bottom'] {
  transform: translateX(-50%);
}

.ds-tooltip[data-side='right'] {
  transform: translateY(-50%);
}
</style>
