<script setup lang="ts">
/**
 * One 小单 frame strip, played with CSS steps() the same way the pet window
 * does (desktop/src/pet/renderer.css): the strip is scaled to `frames × 100%`
 * of the box, so background-position k/(frames-1) lands exactly on frame k.
 * `playing: false` holds the first frame. Key it by sprite id at the call
 * site so a new sprite starts from its first frame.
 */
import { computed } from 'vue'
import { PET_FRAME, type PetSprite } from './petSprites'

const props = withDefaults(
  defineProps<{
    sprite: PetSprite
    /** Rendered height in px; the width follows the frame's aspect ratio. */
    height: number
    playing?: boolean
    /** Accessible name; omitted for a decorative thumbnail. */
    label?: string
  }>(),
  { playing: true, label: '' },
)

const style = computed(() => {
  const { frames, fps, alternate } = props.sprite.strip
  return {
    height: `${props.height}px`,
    width: `${Math.round((props.height * PET_FRAME.width) / PET_FRAME.height)}px`,
    backgroundImage: `url("${props.sprite.url}")`,
    '--pet-frames': String(frames),
    '--pet-duration': `${frames / fps}s`,
    '--pet-direction': alternate ? 'alternate' : 'normal',
  }
})
</script>

<template>
  <div
    class="pet-sprite"
    :class="{ playing }"
    :style="style"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    :data-frames="sprite.strip.frames"
  />
</template>

<style scoped>
.pet-sprite {
  flex: none;
  background-repeat: no-repeat;
  background-position: 0% 0%;
  background-size: calc(var(--pet-frames) * 100%) 100%;
}

.pet-sprite.playing {
  animation: pet-sprite-frames var(--pet-duration)
    steps(var(--pet-frames), jump-none) infinite var(--pet-direction);
}

/* Reduced motion: styles/a11y.css runs every animation once in 1ms, after
   which the base background-position shows the first frame. */
@keyframes pet-sprite-frames {
  from {
    background-position-x: 0%;
  }
  to {
    background-position-x: 100%;
  }
}
</style>
