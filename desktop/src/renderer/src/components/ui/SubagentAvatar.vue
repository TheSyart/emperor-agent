<script setup lang="ts">
import { computed, useId } from 'vue'
import { subagentFrame, subagentFrames, subagentSheet } from './subagentAvatars'
const props = withDefaults(
  defineProps<{ sessionId: string; size?: number; frameId?: string }>(),
  { size: 28 },
)
const frame = computed(
  () =>
    subagentFrames.find((frame) => frame.id === props.frameId) ??
    subagentFrame(props.sessionId),
)
const clip = `native-portrait-${useId()}`
</script>
<template>
  <span
    class="subagent-avatar"
    :data-avatar="frame.id"
    :data-agent-identity="sessionId"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    aria-label="本地子智能体角色头像"
  >
    <svg viewBox="0 0 100 100" focusable="false">
      <svg
        x="8"
        y="8"
        width="84"
        height="84"
        :viewBox="frame.rect.join(' ')"
        preserveAspectRatio="xMidYMid meet"
        overflow="hidden"
      >
        <defs>
          <clipPath :id="clip" clipPathUnits="userSpaceOnUse">
            <rect
              :x="frame.rect[0]"
              :y="frame.rect[1]"
              :width="frame.rect[2]"
              :height="frame.rect[3]"
            />
          </clipPath>
        </defs>
        <image
          :href="subagentSheet(frame.group)"
          width="1254"
          height="1254"
          :clip-path="`url(#${clip})`"
        />
      </svg>
    </svg>
  </span>
</template>
<style scoped>
.subagent-avatar {
  display: inline-flex;
  flex: none;
  overflow: hidden;
  border-radius: var(--radius-row);
  background: transparent;
  vertical-align: middle;
}
.subagent-avatar > svg {
  display: block;
  width: 100%;
  height: 100%;
  fill: none;
  stroke: none;
  overflow: hidden;
}
</style>
