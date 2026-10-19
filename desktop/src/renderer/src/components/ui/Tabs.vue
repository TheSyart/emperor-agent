<script setup lang="ts">
/**
 * Tabs — one tab strip in three looks (DS-04):
 *   variant: underline  page and pane views (default): 13/16 medium; the
 *                       selected tab is primary text with a 2px bar
 *            segmented  filters: a sunken track, the selected segment raised
 *            editor     open files and terminals: flat tabs, the selected one
 *                       on the panel fill; `closable` tabs get a × button
 *   size:    default | large (underline 16/24; segmented 32px)
 * The selected tab uses --text-1 and weight 500, never gold.
 * Keyboard: ArrowLeft / ArrowRight (and ArrowUp / ArrowDown for a radio
 * group) / Home / End move and select, skipping disabled tabs; Delete closes
 * a closable editor tab.
 *
 * Props:
 * - tabs: { id, label, disabled?, icon?, count?, closable? }[].
 * - modelValue (v-model): active tab id.
 * - block?: stretch to the container, equal widths (segmented).
 * - semantics: 'tabs' (tablist, default) | 'radio' (radiogroup; Segmented).
 * Emits: update:modelValue, close(id).
 * aria-label and other attributes land on the strip.
 */
import Badge from './Badge.vue'
import Icon from './Icon.vue'
import type { TabItem } from './blockTypes'

const props = withDefaults(
  defineProps<{
    tabs: readonly TabItem[]
    variant?: 'underline' | 'segmented' | 'editor'
    size?: 'default' | 'large'
    block?: boolean
    semantics?: 'tabs' | 'radio'
  }>(),
  { variant: 'underline', size: 'default', block: false, semantics: 'tabs' },
)
const active = defineModel<string>({ required: true })
const emit = defineEmits<{ close: [id: string] }>()

function select(tab: TabItem) {
  if (!tab.disabled) active.value = tab.id
}

function focusable(tab: TabItem): boolean {
  if (props.tabs.some((item) => item.id === active.value && !item.disabled))
    return tab.id === active.value
  return tab.id === props.tabs.find((item) => !item.disabled)?.id
}

function onKeydown(event: KeyboardEvent, tab: TabItem) {
  if (
    event.key === 'Delete' &&
    props.variant === 'editor' &&
    tab.closable &&
    !tab.disabled
  ) {
    event.preventDefault()
    emit('close', tab.id)
    return
  }
  const enabled = props.tabs.filter((item) => !item.disabled)
  const at = enabled.findIndex((item) => item.id === tab.id)
  const vertical = props.semantics === 'radio'
  let next: TabItem | undefined
  if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowDown'))
    next = enabled[(at + 1) % enabled.length]
  else if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowUp'))
    next = enabled[(at - 1 + enabled.length) % enabled.length]
  else if (event.key === 'Home') next = enabled[0]
  else if (event.key === 'End') next = enabled[enabled.length - 1]
  if (!next) return
  event.preventDefault()
  select(next)
  const strip = (event.currentTarget as HTMLElement).closest('.ds-tabs')
  const target = [
    ...(strip?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? []),
  ].find((el) => el.dataset.tabId === next.id)
  target?.focus()
}
</script>

<template>
  <div
    class="ds-tabs"
    :role="semantics === 'radio' ? 'radiogroup' : 'tablist'"
    :data-variant="variant"
    :data-size="size"
    :data-block="block || undefined"
  >
    <span
      v-for="tab in tabs"
      :key="tab.id"
      class="tab-item"
      :data-active="tab.id === active || undefined"
    >
      <button
        type="button"
        :role="semantics === 'radio' ? 'radio' : 'tab'"
        class="tab"
        :data-tab-id="tab.id"
        :aria-selected="semantics === 'radio' ? undefined : tab.id === active"
        :aria-checked="semantics === 'radio' ? tab.id === active : undefined"
        :tabindex="focusable(tab) ? 0 : -1"
        :disabled="tab.disabled"
        @click="select(tab)"
        @keydown="onKeydown($event, tab)"
      >
        <component :is="tab.icon" v-if="tab.icon" class="tab-icon" :size="14" />
        <span class="tab-label">{{ tab.label }}</span>
        <Badge
          v-if="tab.count !== undefined"
          variant="count"
          :label="tab.count"
        />
      </button>
      <button
        v-if="variant === 'editor' && tab.closable"
        type="button"
        class="tab-close"
        tabindex="-1"
        :aria-label="`关闭 ${tab.label}`"
        :disabled="tab.disabled"
        @click.stop="emit('close', tab.id)"
      >
        <Icon name="close" size="xs" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.ds-tabs {
  display: flex;
  align-items: stretch;
  gap: var(--space-4);
  min-width: 0;
}

.tab-item {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  min-width: 0;
}

.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  height: calc(var(--space-8) + var(--space-1));
  padding: 0;
  border: none;
  outline: none;
  background: none;
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-standard),
    background-color var(--motion-fast) var(--ease-standard);
}

.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-icon {
  flex: none;
}

.tab:hover:not(:disabled) {
  color: rgb(var(--text-2));
}

.tab[aria-selected='true'],
.tab[aria-checked='true'] {
  color: rgb(var(--text-1));
}

.tab:disabled {
  color: rgb(var(--text-disabled));
  cursor: default;
}

.tab:focus-visible {
  border-radius: var(--r-xs);
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 4px rgb(var(--focus-ring) / 0.55);
}

/* ── underline ── */
.ds-tabs[data-variant='underline'][data-size='large'] .tab {
  font: var(--weight-medium) var(--type-title-sm) var(--font-sans);
}

.ds-tabs[data-variant='underline'] .tab::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 2px;
  background: rgb(var(--text-1));
  opacity: 0;
  transform: scaleX(0.4);
  transition:
    opacity var(--motion-base) var(--ease-standard),
    transform var(--motion-base) var(--ease-standard);
}

.ds-tabs[data-variant='underline'] .tab[aria-selected='true']::after {
  opacity: 1;
  transform: scaleX(1);
}

/* ── segmented ── */
.ds-tabs[data-variant='segmented'] {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
  width: fit-content;
  max-width: 100%;
  height: var(--control-sm);
  padding: var(--space-0-5);
  border-radius: var(--r-sm);
  background: var(--surface-active);
}

.ds-tabs[data-variant='segmented'][data-size='large'] {
  height: var(--control-md);
}

.ds-tabs[data-variant='segmented'][data-block] {
  display: flex;
  width: 100%;
}

.ds-tabs[data-variant='segmented'][data-block] .tab-item {
  flex: 1 1 0;
}

.ds-tabs[data-variant='segmented'] .tab-item {
  height: 100%;
}

.ds-tabs[data-variant='segmented'] .tab {
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0 var(--space-2-5);
  border-radius: calc(var(--r-sm) - 2px);
  color: rgb(var(--text-2));
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.ds-tabs[data-variant='segmented'][data-size='large'] .tab {
  padding: 0 var(--space-3);
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
}

.ds-tabs[data-variant='segmented'] .tab:hover:not(:disabled) {
  color: rgb(var(--text-1));
}

.ds-tabs[data-variant='segmented']
  .tab:is([aria-selected='true'], [aria-checked='true']) {
  background: rgb(var(--surface-overlay));
  box-shadow:
    0 0 0 0.5px var(--stroke-2),
    0 1px 2px rgb(var(--shadow-color) / 0.12);
  color: rgb(var(--text-1));
}

.ds-tabs[data-variant='segmented'] .tab:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

/* ── editor ── */
.ds-tabs[data-variant='editor'] {
  gap: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.ds-tabs[data-variant='editor'] .tab-item {
  flex: none;
  max-width: 220px;
  border-radius: var(--r-sm) var(--r-sm) 0 0;
}

.ds-tabs[data-variant='editor'] .tab-item:hover {
  background: var(--surface-hover);
}

.ds-tabs[data-variant='editor'] .tab-item[data-active] {
  background: rgb(var(--surface-base));
}

.ds-tabs[data-variant='editor'] .tab {
  height: var(--control-md);
  padding: 0 var(--space-3);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}

.ds-tabs[data-variant='editor'] .tab-item:has(.tab-close) .tab {
  padding-right: var(--space-1);
}

.ds-tabs[data-variant='editor'] .tab:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.6);
}

.tab-close {
  display: inline-grid;
  flex: none;
  align-self: center;
  place-items: center;
  width: var(--icon-md);
  height: var(--icon-md);
  margin-right: var(--space-2);
  padding: 0;
  border: none;
  border-radius: var(--r-xs);
  background: transparent;
  color: rgb(var(--text-3));
  cursor: pointer;
  opacity: 0;
}

.tab-item:hover .tab-close,
.tab-item[data-active] .tab-close,
.tab-item:focus-within .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--surface-hover-strong);
  color: rgb(var(--text-1));
}
</style>
