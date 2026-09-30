<script setup lang="ts">
/** mic_16 — composer dictation glyph. Props: size (px, default 16). Color = currentColor. */
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
      x="5.5"
      y="1.75"
      width="5"
      height="8"
      rx="2.5"
      stroke="currentColor"
      stroke-width="1.4"
    />
    <path
      d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
    />
  </svg>
</template>
