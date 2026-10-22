<script setup lang="ts">
/**
 * DisclosureRow — the 28px flow row (tool call / think / context / hook …;
 * UI-S03): 14px icon in text-3, 13px title in text-2, 13px summary in text-3,
 * 「·」 between them.
 *
 * Props:
 * - title: 13 secondary label.
 * - summary?: truncating tertiary text after the 「·」 separator
 *   (or use the `summary` slot).
 * - open (v-model:open): expanded state; uncontrolled when unbound.
 * - expandable (default true): whether a body exists to reveal.
 * - expandOnRowClick (default true): whole row toggles; otherwise only the
 *   leading icon button does.
 * - running: plays the glare sweep over the row.
 * - tone: 'default' | 'error' (summary in the danger color).
 *
 * Slots: `icon` (14px leading glyph; crossfades to a chevron on hover),
 * `summary`, `trailing` (right-aligned actions), default (body, indented 22px,
 * opening and folding with the flow's one CollapseTransition).
 */
import { computed } from 'vue'
import { DsChevronDown } from '../icons/ds'
import CollapseTransition from '../motion/CollapseTransition.vue'

const props = withDefaults(
  defineProps<{
    title: string
    summary?: string
    expandable?: boolean
    expandOnRowClick?: boolean
    running?: boolean
    tone?: 'default' | 'error'
  }>(),
  {
    summary: undefined,
    expandable: true,
    expandOnRowClick: true,
    running: false,
    tone: 'default',
  },
)

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ toggle: [open: boolean] }>()

const rowExpands = computed(() => props.expandable && props.expandOnRowClick)

function toggle() {
  if (!props.expandable) return
  open.value = !open.value
  emit('toggle', open.value)
}

function onKeydown(event: KeyboardEvent) {
  if (!rowExpands.value) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  toggle()
}
</script>

<template>
  <div class="ds-disclosure" :data-open="open || undefined" :data-tone="tone">
    <div
      class="row ds-glare"
      data-disclosure-row
      :data-running="running || undefined"
      :data-expandable="rowExpands || undefined"
      :role="rowExpands ? 'button' : undefined"
      :tabindex="rowExpands ? 0 : undefined"
      :aria-expanded="rowExpands ? open : undefined"
      @click="rowExpands ? toggle() : undefined"
      @keydown="onKeydown"
    >
      <component
        :is="expandable && !rowExpands ? 'button' : 'span'"
        class="leading"
        :type="expandable && !rowExpands ? 'button' : undefined"
        :aria-expanded="expandable && !rowExpands ? open : undefined"
        @click.stop="expandable && !rowExpands ? toggle() : undefined"
      >
        <DsChevronDown v-if="open" :size="14" class="chevron" />
        <template v-else>
          <span class="icon-idle" :data-preview="expandable || undefined">
            <slot name="icon" />
          </span>
          <DsChevronDown
            v-if="expandable"
            :size="14"
            class="chevron chevron-hover"
          />
        </template>
      </component>
      <span class="title">{{ title }}</span>
      <template v-if="summary || $slots.summary">
        <span class="sep" aria-hidden="true">·</span>
        <span class="summary"
          ><slot name="summary">{{ summary }}</slot></span
        >
      </template>
      <span v-if="$slots.trailing" class="trailing" @click.stop>
        <slot name="trailing" />
      </span>
    </div>
    <CollapseTransition>
      <div v-if="open && $slots.default" class="body">
        <slot />
      </div>
    </CollapseTransition>
  </div>
</template>

<style scoped>
.ds-disclosure {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}

.row {
  display: flex;
  align-items: center;
  height: var(--control-sm);
  min-width: 0;
  border-radius: var(--r-xs);
  font: var(--type-footnote) var(--font-sans);
}

.row[data-expandable] {
  cursor: pointer;
}

.row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.leading {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  margin-right: var(--space-1-5);
  padding: 0;
  border: none;
  background: none;
  color: rgb(var(--text-3));
}

button.leading {
  cursor: pointer;
}

.icon-idle {
  display: inline-flex;
  opacity: 1;
  transition: opacity var(--motion-fast) ease;
}

.chevron {
  color: rgb(var(--text-2));
}

/* Collapsed chevron points right; the open row shows it pointing down. */
.chevron-hover {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transform: rotate(-90deg);
  transition: opacity var(--motion-fast) ease;
}

.row:hover .icon-idle[data-preview] {
  opacity: 0;
}

.row:hover .chevron-hover {
  opacity: 1;
}

.title {
  flex: none;
  color: rgb(var(--text-2));
}

.sep {
  flex: none;
  margin: 0 var(--space-1-5);
  color: rgb(var(--text-4));
}

.summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--text-3));
}

[data-tone='error'] .summary {
  color: rgb(var(--error));
}

.trailing {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  padding-left: var(--space-2);
}

.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-left: calc(var(--space-4) + var(--space-1-5));
}
</style>
