<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ src: string; name: string; caption?: string }>()
const emit = defineEmits<{ close: [] }>()
const closeButton = ref<HTMLButtonElement | null>(null)
const returnFocus = document.activeElement

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' && event.key !== 'Tab') return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') emit('close')
  else closeButton.value?.focus()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  void nextTick(() => closeButton.value?.focus())
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
    returnFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div
      class="attachment-preview-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`图片预览：${name}`"
      @click.self="emit('close')"
    >
      <div class="attachment-preview-stage">
        <button
          ref="closeButton"
          type="button"
          class="attachment-preview-close"
          aria-label="关闭图片预览"
          @click="emit('close')"
        >
          ×
        </button>
        <img :src="src" :alt="name" />
        <div class="attachment-preview-caption">
          <strong>{{ name }}</strong>
          <span v-if="caption">{{ caption }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
