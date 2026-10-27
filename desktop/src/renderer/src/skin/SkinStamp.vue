<script setup lang="ts">
/**
 * SkinStamp — the skin's `approved` picture (朱批: the 「单」 seal) for a
 * moment after the user allows an action (BRD-05). It sits beside the
 * composer, never on the permission card, and only decorates: the card's
 * words and buttons are its own.
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import SkinSlot from './SkinSlot.vue'
import { approvals, skinSlotUrl } from './skinState'

const STAMP_MS = 1400
const shown = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

watch(approvals, () => {
  if (!skinSlotUrl('approved')) return
  if (timer) clearTimeout(timer)
  shown.value = true
  timer = setTimeout(() => {
    shown.value = false
    timer = null
  }, STAMP_MS)
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <SkinSlot v-if="shown" name="approved" class="skin-stamp" />
</template>

<style scoped>
.skin-stamp {
  position: absolute;
  right: var(--space-6);
  bottom: calc(100% - var(--space-4));
  width: calc(var(--space-8) * 2);
  rotate: -8deg;
  animation: skin-stamp var(--motion-slow) var(--ease-spring) both;
}

/* Pressed down like a seal; it leaves when the moment is over. */
@keyframes skin-stamp {
  from {
    opacity: 0;
    scale: 1.6;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
</style>
