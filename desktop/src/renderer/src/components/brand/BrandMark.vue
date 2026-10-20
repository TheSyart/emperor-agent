<script setup lang="ts">
/**
 * The Emperor mark (UI-S12): a rounded seal holding a crown line over a
 * hexagon node and a mirrored emblem, drawn as vector in `--brand` gold so
 * it stays crisp at any size and follows the theme. The same geometry is
 * `assets/generated/emperor-mark.svg` (the favicon, README, app icon art).
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    size?: number | string
    alt?: string
  }>(),
  {
    size: 24,
    alt: '',
  },
)

const dimension = computed(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
)
</script>

<template>
  <svg
    class="brand-mark"
    viewBox="141 141.5 970 970"
    :role="props.alt ? 'img' : undefined"
    :aria-label="props.alt || undefined"
    :aria-hidden="props.alt ? undefined : 'true'"
    :style="{ width: dimension, height: dimension }"
  >
    <path
      fill-rule="evenodd"
      d="M343 167H909A190 190 0 0 1 1099 357V896A190 190 0 0 1 909 1086H343A190 190 0 0 1 153 896V357A190 190 0 0 1 343 167ZM343 231A126 126 0 0 0 217 357V896A126 126 0 0 0 343 1022H909A126 126 0 0 0 1035 896V357A126 126 0 0 0 909 231Z"
    />
    <path d="M626.5 297L703.6 341.5V430.5L626.5 475L549.4 430.5V341.5Z" />
    <path d="M282 383H366L440 488H813L887 383H971L885 562H368Z" />
    <path
      d="M275 603H569L617 651V961H549V736A60 60 0 0 0 489 676H275ZM275 728H460A45 45 0 0 1 505 773V961H416V799H275Z"
    />
    <path
      d="M978 603H684L636 651V961H704V736A60 60 0 0 1 764 676H978ZM978 728H793A45 45 0 0 0 748 773V961H837V799H978Z"
    />
  </svg>
</template>

<style scoped>
.brand-mark {
  display: inline-block;
  flex: none;
  fill: rgb(var(--brand));
}
</style>
