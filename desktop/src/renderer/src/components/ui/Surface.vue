<script setup lang="ts">
/**
 * Surface — a panel-level container (DS-04), replacing hand-drawn card
 * frames: one fill, one radius, no stacked borders.
 *   tone:   raised (default; a step up from the panel, hairline) |
 *           sunken (wells, code) | overlay (floating, elevated)
 *   pad:    none | sm 12 | md 16 (default)
 *   radius: md 12 (default) | lg 16
 *   interactive: hover fill and a focus ring (pair with as="button")
 * Slots: default.
 */
withDefaults(
  defineProps<{
    tone?: 'raised' | 'sunken' | 'overlay'
    pad?: 'none' | 'sm' | 'md'
    radius?: 'md' | 'lg'
    interactive?: boolean
    as?: string
  }>(),
  { tone: 'raised', pad: 'md', radius: 'md', interactive: false, as: 'div' },
)
</script>

<template>
  <component
    :is="as"
    class="ds-surface"
    :type="as === 'button' ? 'button' : undefined"
    :data-tone="tone"
    :data-pad="pad"
    :data-radius="radius"
    :data-interactive="interactive || undefined"
  >
    <slot />
  </component>
</template>

<style scoped>
.ds-surface {
  display: block;
  min-width: 0;
  padding: var(--space-4);
  border: none;
  border-radius: var(--r-md);
  outline: none;
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
  color: rgb(var(--text-1));
  font: inherit;
  text-align: inherit;
}

.ds-surface[data-tone='sunken'] {
  background: rgb(var(--surface-sunken));
  box-shadow: none;
}

.ds-surface[data-tone='overlay'] {
  background: rgb(var(--surface-overlay));
  box-shadow: var(--elev-2);
}

.ds-surface[data-pad='none'] {
  padding: 0;
}

.ds-surface[data-pad='sm'] {
  padding: var(--space-3);
}

.ds-surface[data-radius='lg'] {
  border-radius: var(--r-lg);
}

.ds-surface[data-interactive] {
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.ds-surface[data-interactive]:hover {
  background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
}

.ds-surface[data-interactive]:focus-visible {
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}
</style>
