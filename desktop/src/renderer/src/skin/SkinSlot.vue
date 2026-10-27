<script setup lang="ts">
/**
 * SkinSlot — a decoration position (BRD-05). The skin's picture for
 * `name`, or nothing: decoration only (empty alt, hidden from assistive
 * technology, not draggable, never a click target). Every skin picture goes
 * through here, so 「显示吉祥物」 (BRD-04) hides them all in one place. A
 * picture that fails to load makes SkinHost ask main again (a deleted
 * skin falls back to 御书房). Never placed inside an exempt zone.
 */
import { computed } from 'vue'
import type { SkinSlotName } from '../../../shared/skin-contract'
import { skinSlotUrl, verifySkin } from './skinState'

const props = defineProps<{ name: SkinSlotName }>()
const src = computed(() => skinSlotUrl(props.name))
</script>

<template>
  <img
    v-if="src"
    class="skin-slot"
    :src="src"
    alt=""
    aria-hidden="true"
    draggable="false"
    decoding="async"
    :data-skin-slot="name"
    @error="verifySkin()"
  />
</template>

<style scoped>
.skin-slot {
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}
</style>
