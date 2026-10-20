<script setup lang="ts">
/**
 * PageShell — frame of a full-page route (定时任务 / 能力 / GitHub): a
 * scrolling center column — content 880px wide (UI-S08) — holding the
 * 20/600 title row (title, optional subtitle, and the page's header actions
 * right-aligned), the tab strip under the title, then the page body.
 *
 * It provides the settings header host, so sections reused from the
 * settings modal keep publishing their actions with `useSettingsHeader`
 * (rendered here by SettingsHeaderBar). A page's own actions come in through
 * the `actions` prop instead: the page renders PageShell, so it sits above
 * the host and cannot inject it. The content column (≤ 880px) is the
 * `settings-panel` inline-size container, so the sections' existing
 * `@container settings-panel` rules keep applying.
 *
 * Props: title; subtitle?; actions? (page-level header actions, drawn
 * before those the body registers); fill? — for workspace pages (Pull
 * Request, the one full-width page): no column cap and no outer scroll, the
 * body is a full-width, full-height flex column that scrolls on its own.
 * Its title row and tabs stay in the same 880 column and at the same height
 * as on every other page, so switching between the GitHub tabs (PR / Issue /
 * CI) never moves the title. The default layout is the capped, scrolling
 * column.
 * Slots: tabs (optional strip under the title row); default (page body).
 */
import { computed, useId } from 'vue'
import SettingsHeaderBar from '../settings/SettingsHeaderBar.vue'
import {
  provideSettingsHeader,
  type SettingsHeaderAction,
} from '../settings/settingsHeader'

const props = defineProps<{
  title: string
  subtitle?: string
  actions?: readonly SettingsHeaderAction[]
  fill?: boolean
}>()

const header = provideSettingsHeader()
const actions = computed(() => [
  ...(props.actions ?? []),
  ...header.actions.value,
])
const titleId = `page-title-${useId()}`
</script>

<template>
  <section
    class="page-shell"
    :aria-labelledby="titleId"
    :data-fill="fill || undefined"
  >
    <div class="page-scroll">
      <div class="page-column">
        <header class="page-header">
          <div class="title-row">
            <div class="titles">
              <h1 :id="titleId" class="page-title">{{ title }}</h1>
              <p v-if="subtitle" class="page-subtitle">{{ subtitle }}</p>
            </div>
            <SettingsHeaderBar class="page-actions" :actions="actions" />
          </div>
          <div v-if="$slots.tabs" class="page-tabs">
            <slot name="tabs" />
          </div>
        </header>
        <div class="page-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--label-primary));
}

.page-scroll {
  container: page-shell / inline-size;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.page-column {
  container: settings-panel / inline-size;
  box-sizing: border-box;
  width: 100%;
  max-width: calc(880px + 2 * var(--space-6));
  margin: 0 auto;
  padding: var(--space-8) var(--space-6) var(--space-8);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.page-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  min-width: 0;
}

.titles {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.page-title {
  margin: 0;
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--font-size-2xl);
  line-height: var(--space-7);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-subtitle {
  margin: 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.page-actions {
  flex: none;
  padding-top: var(--space-0-5);
}

.page-tabs {
  border-bottom: 1px solid var(--stroke-2);
}

@container page-shell (max-width: 639px) {
  .page-column {
    padding: var(--space-5) var(--space-4) var(--space-6);
  }
}

/* fill: the body takes the rest of the page and scrolls internally. */
.page-shell[data-fill] .page-scroll {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.page-shell[data-fill] .page-column {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  max-width: none;
  padding: var(--space-8) 0 0;
}

/* The header keeps the 880 column of the other pages (same title spot). */
.page-shell[data-fill] .page-header {
  box-sizing: border-box;
  width: 100%;
  max-width: calc(880px + 2 * var(--space-6));
  margin: 0 auto var(--space-5);
  padding: 0 var(--space-6);
}

@container page-shell (max-width: 639px) {
  .page-shell[data-fill] .page-column {
    padding: var(--space-5) 0 0;
  }

  .page-shell[data-fill] .page-header {
    padding: 0 var(--space-4);
  }
}

.page-shell[data-fill] .page-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
</style>
