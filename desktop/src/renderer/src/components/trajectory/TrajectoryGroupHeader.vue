<script setup lang="ts">
/**
 * TrajectoryGroupHeader — the Step / Compaction group boundary of the
 * ledger. dsh folds the legacy "Step N · 1.2 s" header row into a 5px
 * request dot sitting on the boundary line of the group's first record;
 * hover reveals `Request #N`, click opens the request inspector (Summary /
 * Options / Usage / Timing). Coincident markers (request-only separators)
 * fan out 8px apart.
 *
 * Props: marker (RequestMarker); selected?; description? (group wall span /
 * tool histogram, shown as the native title).
 * Emits: select.
 */
import { computed } from 'vue'
import type { RequestMarker } from './ledgerRows'

const props = withDefaults(
  defineProps<{
    marker: RequestMarker
    selected?: boolean
    description?: string
  }>(),
  { selected: false, description: undefined },
)
defineEmits<{ select: [] }>()

const title = computed(() =>
  [props.marker.group, props.description].filter(Boolean).join(' · '),
)
</script>

<template>
  <button
    type="button"
    class="traj-request-marker"
    :aria-label="marker.label"
    :aria-pressed="selected"
    :title="title"
    :data-label="marker.label"
    :data-request-status="marker.status"
    :data-request-run-index="marker.runIndex"
    :style="{ '--traj-request-offset': `${marker.runIndex * 8}px` }"
    @click.stop="$emit('select')"
    @dblclick.stop
  />
</template>

<style scoped>
.traj-request-marker {
  position: absolute;
  z-index: var(--z-drawer);
  top: calc(-1 * var(--space-2));
  left: calc(var(--space-3) + var(--traj-request-offset, 0px));
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.traj-request-marker::before {
  position: absolute;
  top: 5.5px;
  left: 5.5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgb(var(--label-caption));
  box-shadow: 0 0 0 2px rgb(var(--bg-layer-1));
  content: '';
  transition:
    background-color var(--duration-fast) var(--ease-in-out),
    box-shadow var(--duration-fast) var(--ease-in-out);
}

.traj-request-marker::after {
  position: absolute;
  top: 2px;
  left: calc(var(--space-4) + 1px);
  width: max-content;
  padding: 0 var(--space-1);
  border: 1px solid var(--border-l1);
  border-radius: 2px;
  color: rgb(var(--label-secondary));
  background: rgb(var(--bg-layer-1));
  box-shadow: var(--shadow-lv2);
  content: attr(data-label);
  font: 9px / 12px var(--font-mono);
  opacity: 0;
  pointer-events: none;
  transform: translateX(-2px);
  transition:
    opacity var(--duration-fast) var(--ease-in-out),
    transform var(--duration-fast) var(--ease-in-out);
  user-select: none;
  white-space: nowrap;
}

.traj-request-marker:hover::before,
.traj-request-marker:focus-visible::before {
  background: rgb(var(--accent-fill));
}

.traj-request-marker[aria-pressed='true']::before {
  background: color-mix(
    in srgb,
    rgb(var(--accent-fill)) 18%,
    rgb(var(--bg-layer-1))
  );
  box-shadow: 0 0 0 1.5px rgb(var(--accent-fill));
}

.traj-request-marker[data-request-status='error']::before {
  background: rgb(var(--danger));
}

.traj-request-marker:hover::after,
.traj-request-marker:focus-visible::after {
  opacity: 1;
  transform: translateX(0);
}

.traj-request-marker:focus-visible {
  outline: none;
}
</style>
