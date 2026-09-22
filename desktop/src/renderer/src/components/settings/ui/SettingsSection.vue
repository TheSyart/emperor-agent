<script setup lang="ts">
/**
 * SettingsSection — root of one settings page inside the modal's options
 * area (the shell header already shows the section title; do not repeat it).
 * Establishes the `inline-size` container every settings primitive queries
 * with @container, so layouts react to the 564px column, not the viewport.
 *
 * Props:
 * - intro?: one-paragraph 13/20 tertiary lead-in above the content.
 * - fill?: stretch to the visible options height (flex column) so a child
 *   editor can take the remaining space (`flex: 1; min-height: 0`); taller
 *   content still scrolls with the options area.
 * Slots: `intro` (rich lead-in, replaces the prop), default (groups / rows /
 * cards).
 */
withDefaults(defineProps<{ intro?: string; fill?: boolean }>(), {
  intro: undefined,
  fill: false,
})
</script>

<template>
  <section class="ds-settings-section" :data-fill="fill || undefined">
    <p v-if="$slots.intro || intro" class="intro">
      <slot name="intro">{{ intro }}</slot>
    </p>
    <div class="body"><slot /></div>
  </section>
</template>

<style scoped>
.ds-settings-section {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
}

.ds-settings-section[data-fill] {
  flex: 1 0 auto;
}

.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ds-settings-section[data-fill] .body {
  flex: 1 0 auto;
}

.intro {
  margin: 0;
  padding: var(--space-1) 0 var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  text-wrap: pretty;
}
</style>
