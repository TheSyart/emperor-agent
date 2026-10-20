<script setup lang="ts">
/**
 * SettingsCard — the dsh settings card (PluginCard / provider row): a header
 * naming the thing (leading glyph, 14/22 medium title, 13/20 tertiary
 * description, inline meta badges, right-side actions), an optional body
 * and a hairline-separated footer. Expandable cards disclose the body in
 * place: the whole header toggles (except the actions area) and the title is
 * the keyboard toggle (button, aria-expanded / aria-controls).
 *
 * Props:
 * - title?, description?: header text (or the `title` / `description` slots).
 * - expandable?: body shows only while open; header gets a chevron.
 * - open (v-model:open): expanded state (ignored unless expandable).
 * - variant: 'default' (settings card fill + l2 border) | 'outline' (transparent,
 *   l2 border — rows on the panel) | 'filled' (selector fill, no border —
 *   editors / add forms nested under a row).
 * - disabled?: dims the header and blocks toggling.
 * - master?: a page's master switch (电脑操作, 浏览器), its first card: the
 *   leading glyph (18px) sits on a 36px gold tile and the title is
 *   semibold.
 * Slots: `leading` (16px glyph / Dot), `title`, `description`, `meta`
 * (badges after the title), `actions` (buttons / Switch; never toggles),
 * default (body), `footer` (right-aligned buttons, e.g. 取消 / 保存).
 * Emits: toggle(open).
 */
import { useSlots } from 'vue'
import { DsChevronDown } from '../../icons/ds'
import { settingsId } from '../../ui/fieldContext'
import { provideSurface } from '../../ui/surface'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    expandable?: boolean
    variant?: 'default' | 'outline' | 'filled'
    disabled?: boolean
    master?: boolean
  }>(),
  {
    title: undefined,
    description: undefined,
    expandable: false,
    variant: 'default',
    disabled: false,
    master: false,
  },
)

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ toggle: [open: boolean] }>()
const slots = useSlots()
// Rows in the card body keep the body's own padding, not the card-group look.
provideSurface(() => 'panel')
const bodyId = settingsId('settings-card-body')

// Slots are not reactive: evaluate these during render (the template calls
// them), so a slot the parent adds or drops later (`<template v-if #default>`)
// shows up on the next render instead of being fixed at the first one.
function hasHeader(): boolean {
  return (
    Boolean(props.title || props.description) ||
    Boolean(slots.title || slots.description || slots.leading || slots.actions)
  )
}

function showBody(): boolean {
  return Boolean(slots.default) && (!props.expandable || open.value)
}

function toggle() {
  if (!props.expandable || props.disabled) return
  open.value = !open.value
  emit('toggle', open.value)
}

function onHeaderClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-card-actions]')) return
  toggle()
}
</script>

<template>
  <div
    class="ds-settings-card"
    :data-variant="variant"
    :data-expandable="expandable || undefined"
    :data-open="(expandable && open) || undefined"
    :data-disabled="disabled || undefined"
    :data-master="master || undefined"
  >
    <div v-if="hasHeader()" class="head" @click="onHeaderClick">
      <span v-if="$slots.leading" class="leading"><slot name="leading" /></span>
      <component
        :is="expandable ? 'button' : 'div'"
        :type="expandable ? 'button' : undefined"
        class="head-text"
        :aria-expanded="expandable ? open : undefined"
        :aria-controls="expandable ? bodyId : undefined"
        :disabled="expandable && disabled ? true : undefined"
      >
        <span class="title-line">
          <span v-if="$slots.title || title" class="title">
            <slot name="title">{{ title }}</slot>
          </span>
          <slot name="meta" />
        </span>
        <span v-if="$slots.description || description" class="description">
          <slot name="description">{{ description }}</slot>
        </span>
      </component>
      <div v-if="$slots.actions" class="actions" data-card-actions>
        <slot name="actions" />
      </div>
      <DsChevronDown
        v-if="expandable"
        :size="14"
        class="chevron"
        aria-hidden="true"
      />
    </div>
    <div
      v-if="showBody()"
      :id="bodyId"
      class="body"
      :data-after-head="hasHeader() || undefined"
    >
      <slot />
    </div>
    <div
      v-if="$slots.footer && (!expandable || open)"
      class="footer"
      data-card-footer
    >
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.ds-settings-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-card);
  background: rgb(var(--settings-card-fill));
  transition:
    border-color var(--duration-ds-fast) ease,
    background-color var(--duration-ds-fast) ease;
}

.ds-settings-card[data-variant='outline'] {
  background: transparent;
}

.ds-settings-card[data-variant='filled'] {
  border-color: transparent;
  background: rgb(var(--selector-fill));
}

.ds-settings-card[data-expandable]:not([data-disabled]):hover {
  border-color: rgb(var(--label-dimmed));
}

.ds-settings-card[data-variant='filled'][data-expandable]:hover {
  border-color: transparent;
}

/* An open card reads as the one being worked on, not merely taller. */
.ds-settings-card[data-open] {
  border-color: rgb(var(--label-dimmed));
  background: rgb(var(--surface-raised));
}

.ds-settings-card[data-variant='filled'][data-open] {
  border-color: transparent;
  background: rgb(var(--selector-fill));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3) var(--space-4);
}

.ds-settings-card[data-expandable] .head {
  cursor: pointer;
}

.ds-settings-card[data-disabled] .head {
  cursor: default;
  opacity: 0.6;
}

.leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: rgb(var(--label-secondary));
}

/* A page's master switch: the glyph on a gold tile, a semibold title. */
.ds-settings-card[data-master] .head {
  padding: var(--space-3-5) var(--space-4);
}

.ds-settings-card[data-master] .leading {
  width: calc(var(--space-8) + var(--space-1));
  height: calc(var(--space-8) + var(--space-1));
  border-radius: var(--radius-cell);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
}

.ds-settings-card[data-master] .title {
  font-weight: 600;
}

.head-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-row);
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
}

button.head-text {
  cursor: pointer;
}

button.head-text:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.description {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  cursor: default;
}

.chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.ds-settings-card[data-open] .chevron {
  transform: rotate(180deg);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3-5) var(--space-4);
}

.body[data-after-head] {
  margin: 0 var(--space-4);
  padding: var(--space-3) 0 var(--space-4);
  border-top: 1px solid var(--stroke-2);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--stroke-2);
}
</style>
