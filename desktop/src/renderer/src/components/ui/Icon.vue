<script setup lang="ts">
/**
 * Icon — one glyph from the registry (iconRegistry.ts) at a token size:
 * xs 12 | sm 14 | md 16 | lg 20. Lucide glyphs draw with a 1.5 stroke.
 * Off-scale sizes (13, 15, 18, 22…) are refused in development and drawn
 * at md.
 */
import { computed } from 'vue'
import { ICON_SIZES, resolveIcon, type IconSize } from './iconRegistry'

const props = withDefaults(defineProps<{ name: string; size?: IconSize }>(), {
  size: 'md',
})

const pixels = computed(() => {
  const value = ICON_SIZES[props.size as IconSize]
  if (value !== undefined) return value
  if (import.meta.env.DEV)
    console.error(
      `Icon size "${String(props.size)}" is off the scale; use xs | sm | md | lg`,
    )
  return ICON_SIZES.md
})

const glyph = computed(() => {
  const found = resolveIcon(props.name)
  if (!found && import.meta.env.DEV)
    console.error(`Icon "${props.name}" is not in the registry`)
  return found
})
</script>

<template>
  <component
    :is="glyph.component"
    v-if="glyph"
    class="ds-icon"
    :size="pixels"
    v-bind="glyph.lucide ? { 'stroke-width': 1.5 } : {}"
    aria-hidden="true"
  />
</template>

<style scoped>
.ds-icon {
  flex: none;
}
</style>
