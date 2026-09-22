<script setup lang="ts">
/** ic_ds_light_outline_16 (ported from dsh ui-primitives icons). Props: size (px, default 16). Color = currentColor. */
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
      d="M11.3496 8C11.3496 6.14985 9.85015 4.65039 8 4.65039C6.14985 4.65039 4.65039 6.14985 4.65039 8C4.65039 9.85015 6.14985 11.3496 8 11.3496C9.85015 11.3496 11.3496 9.85015 11.3496 8ZM12.6504 8C12.6504 10.5681 10.5681 12.6504 8 12.6504C5.43188 12.6504 3.34961 10.5681 3.34961 8C3.34961 5.43188 5.43188 3.34961 8 3.34961C10.5681 3.34961 12.6504 5.43188 12.6504 8Z"
      fill="currentColor"
    />
    <path d="M8.65039 0.5V2.5H7.34961V0.5H8.65039Z" fill="currentColor" />
    <path d="M8.65039 13.5V15.5H7.34961V13.5H8.65039Z" fill="currentColor" />
    <path
      d="M3.15808 2.24035L4.57229 3.65456L3.6525 4.57435L2.23829 3.16014L3.15808 2.24035Z"
      fill="currentColor"
    />
    <path
      d="M12.3505 11.4327L13.7647 12.8469L12.8449 13.7667L11.4307 12.3525L12.3505 11.4327Z"
      fill="currentColor"
    />
    <path
      d="M2.24537 12.8469L3.65958 11.4327L4.57937 12.3525L3.16516 13.7667L2.24537 12.8469Z"
      fill="currentColor"
    />
    <path
      d="M11.4377 3.65455L12.852 2.24033L13.7718 3.16012L12.3575 4.57434L11.4377 3.65455Z"
      fill="currentColor"
    />
    <path d="M0.5 7.35461H2.5V8.6554H0.5L0.5 7.35461Z" fill="currentColor" />
    <path d="M13.5 7.35461H15.5V8.6554H13.5V7.35461Z" fill="currentColor" />
  </svg>
</template>
