<script setup lang="ts">
/** shield_alert_16 — full-access permission preset (dsh PermissionSelect). Props: size (px, default 16). Color = currentColor. */
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
    <path
      d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z"
      stroke="currentColor"
      stroke-width="1.31831"
      stroke-linejoin="round"
    />
    <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
    <path
      d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z"
      fill="currentColor"
    />
  </svg>
</template>
