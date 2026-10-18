<script setup lang="ts">
import { computed, useId } from 'vue'
import { avatarSeed } from '../workspace/environmentModel'
import { subagentPortrait } from './subagentPortraits'

const props = withDefaults(
  defineProps<{ id: string; size?: number; status?: string }>(),
  { size: 24 },
)
// Stable identity across status updates, reorder, reload and history replay.
const clipId = `portrait-${useId()}`
const portrait = computed(() => subagentPortrait(avatarSeed(props.id)))
</script>

<template>
  <span
    class="subagent-avatar"
    :data-avatar="portrait.id"
    :data-status="status"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <svg class="portrait" viewBox="0 0 100 100" focusable="false">
      <!-- Each measured window excludes neighboring heads. Aspect fit and
           equal inset preserve ears/antennae and center different silhouettes. -->
      <svg
        data-portrait-frame
        x="8"
        y="8"
        width="84"
        height="84"
        :viewBox="portrait.rect.join(' ')"
        preserveAspectRatio="xMidYMid meet"
        overflow="hidden"
      >
        <defs>
          <clipPath :id="clipId" clipPathUnits="userSpaceOnUse">
            <rect
              :x="portrait.rect[0]"
              :y="portrait.rect[1]"
              :width="portrait.rect[2]"
              :height="portrait.rect[3]"
            />
          </clipPath>
        </defs>
        <image
          :href="portrait.sheet"
          width="1254"
          height="1254"
          :clip-path="`url(#${clipId})`"
        />
      </svg>
    </svg>
  </span>
</template>

<style scoped>
.subagent-avatar {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-row);
  background: rgb(var(--avatar-surface));
}
.portrait {
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
}
.subagent-avatar[data-status]::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -1px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  border: 1.5px solid rgb(var(--bg-layer-1));
  background: rgb(var(--label-tertiary));
}
.subagent-avatar[data-status='running']::after {
  background: rgb(var(--accent-strong));
}
.subagent-avatar[data-status='completed']::after {
  background: rgb(var(--ok));
}
.subagent-avatar[data-status='failed']::after {
  background: rgb(var(--danger));
}
</style>
