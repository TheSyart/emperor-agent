<script setup lang="ts">
/** terminal_16 — shell prompt glyph (Emperor, dsh line weight). Props: size (px, default 16). Color = currentColor. */
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect
      x="1.35"
      y="2.35"
      width="13.3"
      height="11.3"
      rx="2.4"
      stroke="currentColor"
      stroke-width="1.3"
    />
    <path
      d="M4.5 6l2 2-2 2M8.5 10.25h3"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
