<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import { closeImageViewer, imageViewer } from './imageViewer'
const props = defineProps<{ owner: string }>()
const ImageLightbox = defineAsyncComponent(() => import('./ImageLightbox.vue'))
watch(
  [() => props.owner, imageViewer],
  ([owner, request]) => {
    if (request && request.owner !== owner) closeImageViewer()
  },
  { flush: 'sync' },
)
</script>
<template>
  <ImageLightbox v-if="imageViewer && imageViewer.owner === owner" />
</template>
