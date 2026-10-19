<script setup lang="ts">
/**
 * SettingsHero — the head of a settings sub page that is about one thing
 * (e.g. 电脑操作 › Chrome 和 Edge): a 20/28 title, its status badge and a
 * one-line description under it, and the page's own actions on the right
 * (they wrap under the title in a narrow section). This is the one heading
 * a section body may render; sections and plain sub pages keep using the
 * shell header's title.
 *
 * Props: title, description?.
 * Slots: `badge` (Badge), `description`, `actions` (ui/Button size="sm").
 */
withDefaults(defineProps<{ title: string; description?: string }>(), {
  description: undefined,
})
</script>

<template>
  <div class="ds-settings-hero">
    <div class="text">
      <h2 class="title">{{ title }}</h2>
      <div
        v-if="$slots.badge || $slots.description || description"
        class="meta"
      >
        <slot name="badge" />
        <span v-if="$slots.description || description" class="description">
          <slot name="description">{{ description }}</slot>
        </span>
      </div>
    </div>
    <div v-if="$slots.actions" class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.ds-settings-hero {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3) var(--space-4);
  min-width: 0;
  padding: var(--space-1) 0 var(--space-1);
}

.text {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.title {
  margin: 0;
  font-size: var(--fs-hero);
  line-height: var(--lh-hero);
  font-weight: 600;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.description {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-0-5);
}
</style>
