<script setup lang="ts">
/**
 * Tabs — dsh underline tabs (13/16 medium; active = primary label with a
 * 2px gold underline). Arrow/Home/End keyboard navigation.
 *
 * Props:
 * - tabs: { id, label, disabled? }[].
 * - modelValue (v-model): active tab id.
 * - size: 'default' (13/16) | 'large' (16/24, conversation header).
 */
import type { TabItem } from './blockTypes'

const props = withDefaults(
  defineProps<{ tabs: TabItem[]; size?: 'default' | 'large' }>(),
  { size: 'default' },
)
const active = defineModel<string>({ required: true })

function select(tab: TabItem) {
  if (!tab.disabled) active.value = tab.id
}

function onKeydown(event: KeyboardEvent, index: number) {
  const enabled = props.tabs.filter((tab) => !tab.disabled)
  const at = enabled.findIndex((tab) => tab.id === props.tabs[index]?.id)
  let next: TabItem | undefined
  if (event.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length]
  else if (event.key === 'ArrowLeft')
    next = enabled[(at - 1 + enabled.length) % enabled.length]
  else if (event.key === 'Home') next = enabled[0]
  else if (event.key === 'End') next = enabled[enabled.length - 1]
  if (!next) return
  event.preventDefault()
  select(next)
  const list = (event.currentTarget as HTMLElement).parentElement
  const target = [
    ...(list?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []),
  ].find((el) => el.dataset.tabId === next.id)
  target?.focus()
}
</script>

<template>
  <div class="ds-tabs" role="tablist" :data-size="size">
    <button
      v-for="(tab, index) in tabs"
      :key="tab.id"
      type="button"
      role="tab"
      class="tab"
      :data-tab-id="tab.id"
      :aria-selected="tab.id === active"
      :tabindex="tab.id === active ? 0 : -1"
      :disabled="tab.disabled"
      @click="select(tab)"
      @keydown="onKeydown($event, index)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.ds-tabs {
  display: flex;
  align-items: stretch;
  gap: var(--space-4);
  min-width: 0;
}

.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--space-4);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-ds-fast) ease;
}

[data-size='large'] .tab {
  font-size: var(--fs-base);
  line-height: var(--lh-base);
}

.tab:hover:not(:disabled) {
  color: rgb(var(--label-secondary));
}

.tab[aria-selected='true'] {
  color: rgb(var(--label-primary));
}

.tab::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--accent-fill));
  opacity: 0;
  transform: scaleX(0.4);
  transition:
    opacity var(--duration-ds) var(--ease-in-out),
    transform var(--duration-ds) var(--ease-in-out);
}

.tab[aria-selected='true']::after {
  opacity: 1;
  transform: scaleX(1);
}

.tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
  border-radius: var(--radius-xs);
}

.tab:disabled {
  color: rgb(var(--label-dimmed));
  cursor: default;
}
</style>
