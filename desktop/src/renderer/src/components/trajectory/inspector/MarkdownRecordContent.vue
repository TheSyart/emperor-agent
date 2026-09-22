<script setup lang="ts">
/**
 * MarkdownRecordContent — Preview / Raw body of user, context, assistant
 * and compacted records (dsh MarkdownRecordContent): Raw shows the source
 * blocks (or plain source text); Preview renders markdown with a collapsible
 * `Thinking` quote, the requested tool calls (jump to their records) and
 * attached images.
 *
 * Props: record; rendered; preview?; thinkingExpanded (v-model).
 * Emits: open-call(callId).
 */
import { computed } from 'vue'
import {
  isTrajectoryToolCallOnly,
  trajectoryMarkdownSource,
  type TrajectoryLedgerRecord,
} from '../../../trajectory/model'
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'
import InspectorMarkdown from './InspectorMarkdown.vue'
import SourceBlocks from './SourceBlocks.vue'

const props = withDefaults(
  defineProps<{
    record: TrajectoryLedgerRecord
    rendered: boolean
    preview?: boolean
  }>(),
  { preview: false },
)
const thinkingExpanded = defineModel<boolean>('thinkingExpanded', {
  default: false,
})
defineEmits<{ 'open-call': [callId: string] }>()

const cell = computed(() => props.record.cell)
const source = computed(() => trajectoryMarkdownSource(cell.value))
const images = computed(
  () =>
    cell.value.sourceBlocks?.filter((block) => block.imageSrc !== undefined) ??
    [],
)
const toolCalls = computed(() =>
  cell.value.kind === 'message'
    ? (cell.value.sourceBlocks?.filter((block) => block.type === 'tool-call') ??
      [])
    : [],
)
const rawSource = computed(() =>
  [cell.value.thinkingDetail, cell.value.outputDetail]
    .filter((value): value is string => value !== undefined && value !== '')
    .join('\n\n'),
)
const emptyLabel = computed(() =>
  isTrajectoryToolCallOnly(cell.value)
    ? 'Tool call only'
    : cell.value.text || 'No content',
)
</script>

<template>
  <SourceBlocks
    v-if="!rendered && (cell.sourceBlocks?.length ?? 0) > 0"
    :blocks="cell.sourceBlocks ?? []"
    @open-call="$emit('open-call', $event)"
  />
  <pre v-else-if="!rendered && cell.thinkingDetail" class="payload">{{
    rawSource
  }}</pre>
  <div
    v-else-if="
      !source &&
      images.length === 0 &&
      toolCalls.length === 0 &&
      !cell.thinkingDetail
    "
    class="no-payload"
  >
    {{ emptyLabel }}
  </div>
  <pre
    v-else-if="!rendered"
    class="payload"
    :data-preview="preview || undefined"
    >{{ source ?? '' }}</pre>
  <div v-else class="assistant-content">
    <div v-if="cell.thinkingDetail" class="thinking">
      <button
        type="button"
        class="thinking-toggle"
        :aria-expanded="thinkingExpanded"
        @click="thinkingExpanded = !thinkingExpanded"
      >
        Thinking
        <DsChevronRight :size="12" class="chevron" />
      </button>
      <InspectorMarkdown
        v-if="thinkingExpanded"
        class="thinking-body"
        :text="cell.thinkingDetail"
        :preview="true"
      />
    </div>
    <InspectorMarkdown
      v-if="cell.kind === 'message' ? cell.outputDetail : source"
      :text="(cell.kind === 'message' ? cell.outputDetail : source) ?? ''"
      :preview="preview"
    />
    <ul v-if="toolCalls.length > 0" class="tool-calls">
      <li v-for="(call, index) in toolCalls" :key="call.callId ?? index">
        <button
          type="button"
          class="tool-call"
          title="Open tool call summary"
          @click="call.callId !== undefined && $emit('open-call', call.callId)"
        >
          <svg
            class="tool-icon"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="tool-text">
            <span class="tool-name">{{ call.toolName ?? 'tool-call' }}</span>
            <span v-if="call.content !== ''" class="tool-args">{{
              call.content
            }}</span>
          </span>
        </button>
      </li>
    </ul>
    <div v-if="images.length > 0" class="images">
      <a
        v-for="(block, index) in images"
        :key="index"
        class="image-link"
        :href="block.imageSrc"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img class="image" :src="block.imageSrc" :alt="block.imageAlt ?? ''" />
      </a>
    </div>
  </div>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.payload {
  box-sizing: border-box;
  margin: 0;
  padding: var(--space-3-5);
  overflow-wrap: anywhere;
  color: rgb(var(--label-primary));
  background: rgb(var(--code-block-bg));
  font: 12px / 19px var(--font-mono);
  tab-size: 2;
  white-space: pre-wrap;
}

.payload[data-preview='true'] {
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
}

.thinking {
  margin: var(--space-1-5) var(--space-3-5) 0 var(--space-3);
  padding-left: var(--space-1-5);
  border-left: 2px solid rgb(var(--label-caption));
  color: rgb(var(--label-secondary));
}

.thinking-toggle {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 18px;
  padding: 0;
  border: 0;
  color: rgb(var(--label-tertiary));
  background: transparent;
  cursor: pointer;
  font: 600 12px / 18px var(--font-sans);
}

.thinking-toggle:hover {
  color: rgb(var(--label-secondary));
}

.chevron {
  transition: transform var(--duration-fast) var(--ease-in-out);
}

.thinking-toggle[aria-expanded='true'] .chevron {
  transform: rotate(90deg);
}

.thinking-body {
  padding: 2px 0;
  color: rgb(var(--label-secondary));
}

.tool-calls {
  margin: 2px var(--space-3-5) var(--space-3);
  padding: 0;
  color: rgb(var(--label-secondary));
  font: 11px / 17px var(--font-mono);
  list-style: none;
}

.tool-call {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: calc(100% + var(--space-1));
  height: 19px;
  margin-left: calc(-1 * var(--space-1));
  padding: 0 var(--space-1);
  border: 0;
  border-radius: 2px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.tool-call:hover {
  background: var(--interactive-bg-hover);
}

.tool-icon {
  flex: none;
  margin-right: var(--space-1);
  color: rgb(var(--label-caption));
}

.tool-text {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.tool-name {
  flex: none;
  margin-right: var(--space-1);
  font-weight: 500;
}

.tool-args {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
}

.images {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-2) var(--space-3-5) var(--space-3-5);
}

.image-link {
  display: block;
  max-width: 100%;
  overflow: hidden;
  border-radius: 2px;
}

.image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
</style>
