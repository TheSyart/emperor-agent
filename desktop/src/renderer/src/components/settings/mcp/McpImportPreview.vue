<script setup lang="ts">
/**
 * McpImportPreview — what the 「添加」 dialog is about to write: one row per
 * recognized server (name, transport, masked target, 新增 / 覆盖 / 跳过 /
 * 已存在), a 「覆盖」 checkbox on conflicts Core would change, the Core
 * warnings, and the parse error when nothing could be recognized.
 *
 * Props: rows (McpPreviewRow[]), warnings, error, pending, idleHint?.
 * Emits: overwrite(name, value).
 */
import { DsWarning } from '../../icons/ds'
import { StatusBadge } from '../ui'
import {
  mcpPreviewKindLabel,
  mcpPreviewKindTone,
  mcpTransportLabel,
  type McpPreviewRow,
} from './mcpModel'

withDefaults(
  defineProps<{
    rows: readonly McpPreviewRow[]
    warnings?: readonly string[]
    error?: string
    pending?: boolean
    idleHint?: string
  }>(),
  { warnings: () => [], error: '', pending: false, idleHint: '' },
)

const emit = defineEmits<{ overwrite: [name: string, value: boolean] }>()

function onOverwrite(name: string, event: Event) {
  emit('overwrite', name, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="mcp-import-preview" :aria-busy="pending || undefined">
    <p v-if="error" class="error" role="alert">
      <DsWarning :size="14" class="glyph" aria-hidden="true" />
      <span>{{ error }}</span>
    </p>
    <template v-else-if="rows.length">
      <div class="head">
        <span>识别到 {{ rows.length }} 个服务器</span>
        <span v-if="pending" class="pending">正在更新预览…</span>
      </div>
      <ul class="rows" aria-label="导入预览">
        <li
          v-for="row in rows"
          :key="row.name"
          class="row"
          :data-kind="row.kind"
          :data-server="row.name"
        >
          <div class="row-main">
            <span class="name">{{ row.name }}</span>
            <StatusBadge mono>{{
              mcpTransportLabel(row.transport)
            }}</StatusBadge>
            <StatusBadge :tone="mcpPreviewKindTone(row.kind)">
              {{ mcpPreviewKindLabel(row.kind) }}
            </StatusBadge>
            <label v-if="row.overwritable" class="overwrite">
              <input
                type="checkbox"
                :checked="row.overwrite"
                :aria-label="`覆盖 ${row.name}`"
                @change="onOverwrite(row.name, $event)"
              />
              <span>覆盖</span>
            </label>
          </div>
          <code v-if="row.target" class="target">{{ row.target }}</code>
          <span v-if="row.overwritable && !row.overwrite" class="note">
            已存在同名服务器，勾选「覆盖」后替换现有配置
          </span>
        </li>
      </ul>
    </template>
    <p v-else-if="pending" class="idle">正在识别…</p>
    <p v-else-if="idleHint" class="idle">{{ idleHint }}</p>

    <ul v-if="!error && warnings.length" class="warnings" aria-label="导入提示">
      <li v-for="warning in warnings" :key="warning" class="warning">
        <DsWarning :size="14" class="glyph" aria-hidden="true" />
        <span>{{ warning }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mcp-import-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--label-secondary));
}

.pending,
.idle {
  font-weight: 400;
  color: rgb(var(--label-tertiary));
}

.idle {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  list-style: none;
}

.row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-2-5) var(--space-3);
  background: rgb(var(--bg-layer-3));
}

.row + .row {
  border-top: 1px solid var(--border-l1);
}

.row-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-width: 0;
}

.name {
  min-width: 0;
  margin-right: var(--space-0-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.overwrite {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  cursor: pointer;
}

.overwrite input {
  width: var(--space-3-5);
  height: var(--space-3-5);
  margin: 0;
  accent-color: rgb(var(--accent-fill));
  cursor: pointer;
}

.target {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.note {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
}

.warnings {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.warning,
.error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1-5);
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--state-warn-label));
  overflow-wrap: anywhere;
}

.error {
  color: rgb(var(--state-error-label));
}

.glyph {
  flex: none;
  margin-top: 2px;
}
</style>
