<script setup lang="ts" generic="T extends string | number">
/**
 * Select — dsh settings selector pill (LanguageRow: 36px, r18, selector
 * fill, 14/22, 12px gap, 14px caption chevron) opening a ui/Menu dropdown
 * whose rows can carry a description; the current option shows a check.
 * Picks up id / aria wiring from a surrounding <Field>.
 *
 * Keyboard: ArrowDown / ArrowUp / Enter / Space on the trigger open the menu
 * with the current option focused; ArrowUp / ArrowDown / Home / End move
 * between options, Enter / Space pick, Escape / Tab close (focus returns to
 * the trigger on Escape and after a pick).
 *
 * Props:
 * - modelValue (v-model): the selected option value.
 * - options: SelectOption[] ({ value, label, description?, disabled? }).
 * - placeholder? (shown when nothing matches), disabled?, invalid?, id?.
 * - size: 'md' (36px, default) | 'sm' (28px capsule for dense rows).
 * - block?: stretch the trigger to the container width.
 * - ariaLabel?: accessible name when no <Field> / row label points here.
 * Emits: update:modelValue, change(value).
 * Other attributes (class, data-*, listeners) land on the trigger button.
 */
import { computed, nextTick, ref } from 'vue'
import Menu from '../../ui/Menu.vue'
import MenuItem from '../../ui/MenuItem.vue'
import { DsChevronDown } from '../../icons/ds'
import { useFieldControl } from './fieldContext'
import type { SelectOption } from './types'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption<T>[]
    placeholder?: string
    disabled?: boolean
    invalid?: boolean
    id?: string
    size?: 'md' | 'sm'
    block?: boolean
    ariaLabel?: string
  }>(),
  {
    placeholder: '请选择',
    disabled: false,
    invalid: false,
    id: undefined,
    size: 'md',
    block: false,
    ariaLabel: undefined,
  },
)

const model = defineModel<T>()
const emit = defineEmits<{ change: [value: T] }>()
const control = useFieldControl(props, 'ds-select')

const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)
const open = ref(false)
const menuWidth = ref(200)

const current = computed(() =>
  props.options.find((option) => option.value === model.value),
)

function items(): HTMLButtonElement[] {
  return [
    ...(list.value?.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled)',
    ) ?? []),
  ]
}

async function openMenu() {
  if (props.disabled) return
  menuWidth.value = Math.max(trigger.value?.offsetWidth ?? 0, 180)
  open.value = true
  await nextTick()
  await nextTick()
  const buttons = items()
  const index = props.options
    .filter((option) => !option.disabled)
    .findIndex((option) => option.value === model.value)
  buttons[Math.max(index, 0)]?.focus()
}

function toggle() {
  if (open.value) open.value = false
  else void openMenu()
}

function pick(option: SelectOption<T>) {
  if (option.disabled) return
  if (option.value !== model.value) {
    model.value = option.value
    emit('change', option.value)
  }
  trigger.value?.focus()
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault()
    void openMenu()
  }
}

function onListKeydown(event: KeyboardEvent) {
  const buttons = items()
  if (!buttons.length) return
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  let next = -1
  if (event.key === 'ArrowDown') next = (at + 1) % buttons.length
  else if (event.key === 'ArrowUp')
    next = (at - 1 + buttons.length) % buttons.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  else if (event.key === 'Tab') {
    open.value = false
    return
  }
  if (next < 0) return
  event.preventDefault()
  buttons[next]?.focus()
}
</script>

<template>
  <button
    v-bind="$attrs"
    :id="control.id.value"
    ref="trigger"
    type="button"
    class="ds-select"
    :data-size="size"
    :data-block="block || undefined"
    :data-invalid="control.invalid.value || undefined"
    :data-placeholder="current ? undefined : true"
    :disabled="disabled"
    aria-haspopup="menu"
    :aria-expanded="open"
    :aria-label="ariaLabel"
    :aria-invalid="control.invalid.value || undefined"
    :aria-describedby="control.describedBy.value"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="value">{{ current?.label ?? placeholder }}</span>
    <DsChevronDown :size="14" class="chevron" />
  </button>
  <Menu
    v-model:open="open"
    :anchor="trigger"
    :width="menuWidth"
    :label="ariaLabel ?? current?.label"
    placement="bottom"
  >
    <div ref="list" class="options" @keydown="onListKeydown">
      <MenuItem
        v-for="option in options"
        :key="String(option.value)"
        :selected="option.value === model"
        :disabled="option.disabled"
        :description="option.description"
        :data-value="option.value"
        @select="pick(option)"
      >
        {{ option.label }}
      </MenuItem>
    </div>
  </Menu>
</template>

<style scoped>
.ds-select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex: none;
  min-width: 0;
  max-width: 100%;
  height: calc(var(--space-8) + var(--space-1));
  padding: 0 var(--space-3-5);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: rgb(var(--selector-fill));
  font: inherit;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
  cursor: pointer;
  transition: background-color var(--duration-ds-fast) ease;
}

.ds-select[data-size='sm'] {
  gap: var(--space-2);
  height: var(--space-7);
  padding: 0 var(--space-2-5) 0 var(--space-3);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.ds-select[data-block] {
  width: 100%;
}

.ds-select:hover:not(:disabled),
.ds-select[aria-expanded='true'] {
  background: var(--interactive-bg-hover);
}

.ds-select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.ds-select[data-invalid] {
  border-color: rgb(var(--state-error));
}

.ds-select:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-select[data-placeholder] .value {
  color: rgb(var(--label-tertiary));
}

.chevron {
  flex: none;
  color: rgb(var(--label-caption));
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.ds-select[aria-expanded='true'] .chevron {
  transform: rotate(180deg);
}

.options {
  display: flex;
  flex-direction: column;
}
</style>
