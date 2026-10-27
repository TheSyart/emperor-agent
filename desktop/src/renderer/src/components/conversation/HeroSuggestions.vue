<script setup lang="ts">
/**
 * HeroSuggestions — the Chat home's five starters under the composer
 * (MOD-03, preview A): small neutral capsules in one wrapping row. A pick
 * hands its opening over as text (`pick`); the parent only fills the
 * composer with it, nothing is sent (heroHome.ts `fillSuggestion`).
 */
import Button from '../ui/Button.vue'
import { HERO_SUGGESTIONS } from './heroSuggestions'

const emit = defineEmits<{ pick: [draft: string] }>()
</script>

<template>
  <div class="hero-suggestions" role="group" aria-label="常用起手式">
    <Button
      v-for="item in HERO_SUGGESTIONS"
      :key="item.id"
      size="sm"
      variant="secondary"
      :data-suggestion="item.id"
      @click="emit('pick', item.draft)"
    >
      {{ item.label }}
    </Button>
  </div>
</template>

<style scoped>
/* Lined up with the composer card's left edge, like the preview. */
.hero-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  box-sizing: border-box;
  width: min(
    calc(var(--composer-card-max) + 2 * var(--composer-clearance)),
    100%
  );
  padding: 0 var(--composer-clearance);
}
</style>
