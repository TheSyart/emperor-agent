<script setup lang="ts">
/**
 * CodeEditor — monospace plain-text editor for JSON / Markdown / YAML in
 * settings (hooks.json, mcp_config.json, SKILL.md, memory files). A native
 * <textarea> (undo, IME, selection all native) on the code-block fill with
 * an optional line-number gutter; it grows with its content between
 * `minLines` and `maxLines` and scrolls inside itself beyond that (both
 * axes when `wrap` is off, so long lines never widen the page).
 * Picks up id / aria wiring from a surrounding <Field>.
 *
 * Props:
 * - modelValue (v-model): string.
 * - language?: 'json' | 'markdown' | 'yaml' | 'text' (data attribute only).
 * - lineNumbers (default true): gutter; hidden when `wrap` is on.
 * - wrap (default false): soft-wrap long lines.
 * - minLines (default 6), maxLines (default 24).
 * - fill?: take the remaining height of a flex column parent (min = minLines).
 * - placeholder?, readonly?, disabled?, invalid?, id?, ariaLabel?.
 * Emits: save (⌘S / Ctrl+S while focused; default prevented).
 * Exposes: focus().
 */
import { computed, ref } from 'vue'
import { useFieldControl } from './fieldContext'

const props = withDefaults(
  defineProps<{
    language?: 'json' | 'markdown' | 'yaml' | 'text'
    lineNumbers?: boolean
    wrap?: boolean
    minLines?: number
    maxLines?: number
    fill?: boolean
    placeholder?: string
    readonly?: boolean
    disabled?: boolean
    invalid?: boolean
    id?: string
    ariaLabel?: string
  }>(),
  {
    language: 'text',
    lineNumbers: true,
    wrap: false,
    minLines: 6,
    maxLines: 24,
    fill: false,
    placeholder: undefined,
    readonly: false,
    disabled: false,
    invalid: false,
    id: undefined,
    ariaLabel: undefined,
  },
)

const model = defineModel<string>({ default: '' })
const emit = defineEmits<{ save: [] }>()
const control = useFieldControl(props, 'settings-code')
const textarea = ref<HTMLTextAreaElement | null>(null)
const scrollTop = ref(0)

const lineCount = computed(() => Math.max(1, model.value.split('\n').length))
const visibleLines = computed(() =>
  Math.min(Math.max(lineCount.value, props.minLines), props.maxLines),
)
const showGutter = computed(() => props.lineNumbers && !props.wrap)
const gutterText = computed(() =>
  Array.from({ length: lineCount.value }, (_, index) => index + 1).join('\n'),
)
const digits = computed(() => String(lineCount.value).length)

function onScroll(event: Event) {
  scrollTop.value = (event.target as HTMLTextAreaElement).scrollTop
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    emit('save')
  }
}

defineExpose({ focus: () => textarea.value?.focus() })
</script>

<template>
  <div
    class="ds-code-editor"
    :data-language="language"
    :data-fill="fill || undefined"
    :data-invalid="control.invalid.value || undefined"
    :data-disabled="disabled || undefined"
    :style="{
      '--code-lines': visibleLines,
      '--code-min-lines': minLines,
      '--code-digits': digits,
    }"
  >
    <div v-if="showGutter" class="gutter" aria-hidden="true">
      <pre
        class="gutter-lines"
        :style="{ transform: `translateY(${-scrollTop}px)` }"
        >{{ gutterText }}</pre>
    </div>
    <textarea
      :id="control.id.value"
      ref="textarea"
      v-model="model"
      class="code"
      :wrap="wrap ? 'soft' : 'off'"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      :placeholder="placeholder"
      :readonly="readonly"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-invalid="control.invalid.value || undefined"
      :aria-describedby="control.describedBy.value"
      @scroll="onScroll"
      @keydown="onKeydown"
    />
  </div>
</template>

<style scoped>
.ds-code-editor {
  --code-pad: var(--space-2);
  display: flex;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  transition: border-color var(--duration-ds-fast) ease;
}

.ds-code-editor:focus-within {
  border-color: rgb(var(--accent-fill));
}

.ds-code-editor[data-invalid] {
  border-color: rgb(var(--state-error));
}

.ds-code-editor[data-fill] {
  flex: 1 1 auto;
  min-height: calc(
    var(--code-min-lines) * var(--lh-xxs) + var(--code-pad) * 2 + 2px
  );
}

.gutter {
  flex: none;
  min-width: calc(var(--code-digits) * 1ch + var(--space-5));
  overflow: hidden;
  border-right: 1px solid var(--border-l1);
  user-select: none;
}

.gutter-lines {
  margin: 0;
  padding: var(--code-pad) var(--space-2-5) var(--code-pad) var(--space-2);
  font: inherit;
  color: rgb(var(--label-caption));
  text-align: right;
  white-space: pre;
}

.code {
  flex: 1;
  min-width: 0;
  height: calc(var(--code-lines) * var(--lh-xxs) + var(--code-pad) * 2);
  margin: 0;
  padding: var(--code-pad) var(--space-3);
  border: none;
  border-radius: 0;
  outline: none;
  background: transparent;
  box-shadow: none;
  font: inherit;
  color: rgb(var(--code-fg));
  tab-size: 2;
  white-space: pre;
  overflow: auto;
  resize: none;
}

.ds-code-editor[data-fill] .code {
  height: auto;
}

.code[wrap='soft'] {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code:focus {
  box-shadow: none;
}

.code::placeholder {
  color: rgb(var(--label-caption));
}

.ds-code-editor[data-disabled] .code {
  color: rgb(var(--label-tertiary));
  cursor: default;
}
</style>
