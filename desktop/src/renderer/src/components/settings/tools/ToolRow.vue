<script setup lang="ts">
/**
 * ToolRow — one registered tool in the Settings › 工具 list: a compact
 * disclosure row (monospace name, read-only / writable badge, one-line
 * description, chevron). Expanded it shows the full description, the
 * execution traits, the parameters (type, required, enum values) and the
 * raw JSON schema (read-only CodeEditor).
 *
 * Props: tool. v-model:open — disclosure state.
 */
import { computed } from 'vue'
import type { ToolInfo } from '../../../types'
import { DsChevronDown } from '../../icons/ds'
import { CodeEditor, StatusBadge, settingsId } from '../ui'
import { toolParams, toolSchemaText } from './toolSchema'

const props = defineProps<{ tool: ToolInfo }>()
const open = defineModel<boolean>('open', { default: false })

const uid = settingsId('tool-row')
const params = computed(() => toolParams(props.tool.parameters))
const schema = computed(() => toolSchemaText(props.tool.parameters))
const source = computed(() =>
  props.tool.source === 'mcp'
    ? `MCP · ${props.tool.server || 'server'}`
    : '内建',
)
</script>

<template>
  <li class="tool-row" :data-open="open || undefined" :data-tool="tool.name">
    <button
      type="button"
      class="row-head"
      :aria-expanded="open"
      :aria-controls="`${uid}-details`"
      @click="open = !open"
    >
      <span class="row-text">
        <span class="row-title">
          <code class="name">{{ tool.name }}</code>
          <StatusBadge :tone="tool.read_only ? 'ok' : 'warn'">
            {{ tool.read_only ? '只读' : '可写' }}
          </StatusBadge>
        </span>
        <span v-if="!open" class="summary">
          {{ tool.description || '无描述' }}
        </span>
      </span>
      <DsChevronDown :size="14" class="chevron" aria-hidden="true" />
    </button>

    <div v-if="open" :id="`${uid}-details`" class="details">
      <p v-if="tool.description" class="description">{{ tool.description }}</p>
      <div class="traits">
        <StatusBadge mono>{{ source }}</StatusBadge>
        <StatusBadge v-if="tool.concurrency_safe" tone="ok"
          >并发安全</StatusBadge
        >
        <StatusBadge v-if="tool.exclusive" tone="warn">独占</StatusBadge>
      </div>

      <div class="block">
        <h4 class="block-title">
          参数 <span class="count">{{ params.length }}</span>
        </h4>
        <p v-if="!params.length" class="empty">这个工具没有声明参数。</p>
        <ul v-else class="params">
          <li v-for="param in params" :key="param.name" class="param">
            <span class="param-head">
              <code class="param-name">{{ param.name }}</code>
              <StatusBadge mono>{{ param.type }}</StatusBadge>
              <StatusBadge v-if="param.required" tone="accent"
                >必填</StatusBadge
              >
            </span>
            <span v-if="param.description" class="param-description">
              {{ param.description }}
            </span>
            <span v-if="param.values.length" class="param-values">
              可选值：{{ param.values.join(' / ') }}
            </span>
          </li>
        </ul>
      </div>

      <div class="block">
        <h4 class="block-title">Schema</h4>
        <CodeEditor
          :model-value="schema"
          language="json"
          readonly
          :line-numbers="false"
          :min-lines="3"
          :max-lines="14"
          :aria-label="`${tool.name} 参数 schema`"
        />
      </div>
    </div>
  </li>
</template>

<style scoped>
.tool-row {
  min-width: 0;
  list-style: none;
  border-bottom: 1px solid var(--border-l2);
}

.tool-row:last-child {
  border-bottom: none;
}

.row-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2-5) var(--space-3-5);
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.row-head:hover,
.tool-row[data-open] > .row-head {
  background: var(--interactive-bg-hover);
}

.row-head:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.row-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.row-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
  transition: transform var(--duration-ds-fast) var(--ease-in-out);
}

.tool-row[data-open] .chevron {
  transform: rotate(180deg);
}

.details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3) var(--space-3-5) var(--space-3-5);
  border-top: 1px solid var(--border-l2);
  background: rgb(var(--selector-fill));
}

.description {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.traits {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.block-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 600;
  color: rgb(var(--label-secondary));
}

.count {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
  font-variant-numeric: tabular-nums;
}

.empty {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.params {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.param {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-l2);
}

.param:first-child {
  padding-top: 0;
}

.param:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.param-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.param-name {
  font: var(--font-code-small);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.param-description,
.param-values {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}
</style>
