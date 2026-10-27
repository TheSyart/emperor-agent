<script setup lang="ts">
/**
 * SkinExempt — a zone a skin may not reach (BRD-05, D8): every token the
 * skin changed is set back to the base theme's value on this wrapper,
 * which draws no box of its own (`display: contents`). Where a wrapper
 * would get in the way, bind useSkinExempt() on the zone's root instead.
 */
import { useSkinExempt } from './skinState'

const exempt = useSkinExempt()
</script>

<template>
  <div class="skin-exempt" data-skin-exempt :style="exempt"><slot /></div>
</template>

<style scoped>
.skin-exempt {
  display: contents;
}
</style>
