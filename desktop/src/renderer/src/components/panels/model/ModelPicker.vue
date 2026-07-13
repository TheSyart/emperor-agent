<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  type CSSProperties,
  watch,
} from 'vue'
import type { DiscoveredModel } from '../../../types'
import { actionIcons } from '../../../icons'
import {
  computeModelPickerPlacement,
  filterModelOptions,
  normalizeModelOptions,
} from './modelPickerModel'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: DiscoveredModel[]
    label: string
    placeholder?: string
    loading?: boolean
  }>(),
  {
    placeholder: '',
    loading: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const uid = getCurrentInstance()?.uid ?? 0
const listboxId = `model-picker-listbox-${uid}`
const input = ref<HTMLInputElement | null>(null)
const listbox = ref<HTMLElement | null>(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(-1)
const placement = ref<'top' | 'bottom'>('bottom')
const popoverStyle = reactive<CSSProperties>({
  left: '0px',
  top: '0px',
  width: '240px',
  maxHeight: '260px',
  visibility: 'hidden',
})
let positionFrame: number | undefined
let resizeObserver: ResizeObserver | null = null

const normalizedOptions = computed(() =>
  normalizeModelOptions(props.options, props.modelValue),
)
const visibleOptions = computed(() =>
  filterModelOptions(normalizedOptions.value, query.value),
)
const activeDescendant = computed(() =>
  activeIndex.value >= 0
    ? `${listboxId}-option-${activeIndex.value}`
    : undefined,
)

function updatePopoverPosition() {
  const target = input.value
  const popover = listbox.value
  if (!target || !popover || !open.value) return
  const rect = target.getBoundingClientRect()
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight
  if (
    rect.bottom <= 0 ||
    rect.top >= viewportHeight ||
    rect.right <= 0 ||
    rect.left >= viewportWidth
  ) {
    closePicker()
    return
  }

  const next = computeModelPickerPlacement({
    anchor: rect,
    contentHeight: Math.max(
      popover.scrollHeight,
      popover.getBoundingClientRect().height,
    ),
    viewportWidth,
    viewportHeight,
  })
  placement.value = next.placement
  popoverStyle.left = `${next.left}px`
  popoverStyle.top = `${next.top}px`
  popoverStyle.width = `${next.width}px`
  popoverStyle.maxHeight = `${next.maxHeight}px`
  popoverStyle.visibility = 'visible'
}

function schedulePopoverPosition() {
  if (!open.value || positionFrame !== undefined) return
  positionFrame = window.requestAnimationFrame(() => {
    positionFrame = undefined
    updatePopoverPosition()
  })
}

function startResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(schedulePopoverPosition)
  if (input.value) resizeObserver.observe(input.value)
  if (listbox.value) resizeObserver.observe(listbox.value)
}

function stopPositioning() {
  if (positionFrame !== undefined) {
    window.cancelAnimationFrame(positionFrame)
    positionFrame = undefined
  }
  resizeObserver?.disconnect()
  resizeObserver = null
}

function addPositionListeners() {
  window.addEventListener('resize', schedulePopoverPosition)
  window.addEventListener('scroll', schedulePopoverPosition, true)
  window.visualViewport?.addEventListener('resize', schedulePopoverPosition)
  window.visualViewport?.addEventListener('scroll', schedulePopoverPosition)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
}

function removePositionListeners() {
  window.removeEventListener('resize', schedulePopoverPosition)
  window.removeEventListener('scroll', schedulePopoverPosition, true)
  window.visualViewport?.removeEventListener('resize', schedulePopoverPosition)
  window.visualViewport?.removeEventListener('scroll', schedulePopoverPosition)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
}

async function openPicker(showAll = true) {
  if (showAll) query.value = ''
  activeIndex.value = -1
  if (!open.value) {
    popoverStyle.visibility = 'hidden'
    open.value = true
    addPositionListeners()
  }
  await nextTick()
  startResizeObserver()
  updatePopoverPosition()
}

function closePicker() {
  if (!open.value) return
  open.value = false
  activeIndex.value = -1
  removePositionListeners()
  stopPositioning()
  popoverStyle.visibility = 'hidden'
}

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target as Node | null
  if (
    target &&
    (input.value?.contains(target) || listbox.value?.contains(target))
  )
    return
  closePicker()
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  query.value = value
  activeIndex.value = -1
  emit('update:modelValue', value)
  void openPicker(false)
}

function selectOption(index: number) {
  const option = visibleOptions.value[index]
  if (!option) return
  emit('update:modelValue', option.id)
  closePicker()
  void nextTick(() => input.value?.focus())
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (open.value) event.preventDefault()
    closePicker()
    return
  }
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Enter'
  )
    return

  if (!open.value) {
    if (event.key === 'Enter') return
    event.preventDefault()
    void openPicker(true)
    return
  }

  if (event.key === 'Enter') {
    if (activeIndex.value >= 0) {
      event.preventDefault()
      selectOption(activeIndex.value)
    }
    return
  }

  event.preventDefault()
  if (!visibleOptions.value.length) return
  const delta = event.key === 'ArrowDown' ? 1 : -1
  activeIndex.value =
    activeIndex.value < 0
      ? delta > 0
        ? 0
        : visibleOptions.value.length - 1
      : (activeIndex.value + delta + visibleOptions.value.length) %
        visibleOptions.value.length
  void nextTick(() => {
    document
      .getElementById(`${listboxId}-option-${activeIndex.value}`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

watch([() => props.loading, () => visibleOptions.value.length, query], () => {
  if (!open.value) return
  void nextTick(schedulePopoverPosition)
})

onBeforeUnmount(() => {
  removePositionListeners()
  stopPositioning()
})
</script>

<template>
  <label class="form-row model-picker-field">
    <span class="form-label">{{ label }}</span>
    <span class="model-picker-control">
      <input
        ref="input"
        :value="modelValue"
        class="form-input model-picker-input"
        :placeholder="placeholder"
        role="combobox"
        :aria-label="label"
        autocomplete="off"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="activeDescendant"
        @focus="openPicker(true)"
        @click="openPicker(true)"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="model-picker-toggle"
        :aria-label="`展开${label}列表`"
        :aria-expanded="open"
        @pointerdown.prevent
        @click="(void openPicker(true), input?.focus())"
      >
        <component :is="actionIcons.caretDown" :size="15" />
      </button>
    </span>
  </label>

  <Teleport to="body">
    <div
      v-if="open"
      :id="listboxId"
      ref="listbox"
      class="model-picker-popover"
      role="listbox"
      :aria-label="`${label}候选模型`"
      :data-placement="placement"
      :style="popoverStyle"
    >
      <div v-if="loading" class="model-picker-state">正在获取模型...</div>
      <template v-else-if="visibleOptions.length">
        <button
          v-for="(option, index) in visibleOptions"
          :id="`${listboxId}-option-${index}`"
          :key="`${option.id}-${option.custom ? 'custom' : 'remote'}`"
          type="button"
          class="model-picker-option"
          :class="{
            active: index === activeIndex,
            selected: option.id === modelValue,
          }"
          role="option"
          :aria-selected="option.id === modelValue"
          @pointerenter="activeIndex = index"
          @pointerdown.prevent="selectOption(index)"
        >
          <span>{{ option.id }}</span>
          <small>{{
            option.custom ? '自定义' : option.ownedBy || '可用模型'
          }}</small>
        </button>
      </template>
      <div v-else class="model-picker-state">
        {{
          options.length
            ? '没有匹配的模型，可继续手动填写'
            : '尚未获取模型，可手动填写 Model ID'
        }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.model-picker-control {
  position: relative;
  display: block;
}

.model-picker-input {
  width: 100%;
  padding-right: 34px !important;
}

.model-picker-toggle {
  position: absolute;
  top: 50%;
  right: 4px;
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 6px;
  color: rgb(var(--fg-subtle));
  transform: translateY(-50%);
}

.model-picker-toggle:hover {
  background: rgb(var(--bg-hover));
  color: rgb(var(--fg));
}

.model-picker-popover {
  position: fixed;
  z-index: 220;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
  background: rgb(var(--bg-elevated));
  box-shadow: 0 12px 30px rgb(0 0 0 / 0.28);
}

.model-picker-option {
  display: grid;
  width: 100%;
  min-height: 42px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 7px 9px;
  border-radius: 6px;
  color: rgb(var(--fg));
  text-align: left;
}

.model-picker-option:hover,
.model-picker-option.active {
  background: rgb(var(--bg-hover));
}

.model-picker-option.selected {
  background: rgb(var(--accent) / 0.12);
}

.model-picker-option span {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-picker-option small,
.model-picker-state {
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.model-picker-state {
  padding: 14px 10px;
  line-height: 1.5;
  text-align: center;
}
</style>
