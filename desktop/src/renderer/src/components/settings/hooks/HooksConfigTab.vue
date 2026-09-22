<script setup lang="ts">
/**
 * Hooks › 配置: config sources (global = editable, project = read-only),
 * load errors, per-event command counts (right-aligned, two columns when
 * they fit) and the full-width hooks.json editor with its validation result
 * and one bottom action row (还原 / 校验 / 保存; ⌘S saves).
 */
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import { CodeEditor, SettingsGroup, SettingsRow, StatusBadge } from '../ui'
import { useHooksController } from './hooksController'

const {
  saving,
  payload,
  metadata,
  draft,
  dirty,
  validation,
  eventRows,
  total,
  loadErrors,
  projectFiles,
  validate,
  save,
  onDraftInput,
  resetDraft,
} = useHooksController()

const issues = computed(() => {
  const result = validation.value
  if (!result) return []
  return [
    ...result.errors.map((text) => ({ kind: 'error', text })),
    ...result.unknownEvents.map((name) => ({
      kind: name,
      text: '不支持的事件，将被忽略',
    })),
    ...result.skipped.map((item) => ({
      kind: 'skipped',
      text: JSON.stringify(item),
    })),
  ]
})

const validationState = computed(() => {
  if (!validation.value) return 'idle'
  return validation.value.valid ? 'valid' : 'invalid'
})
</script>

<template>
  <div class="hooks-config">
    <SettingsGroup title="配置来源">
      <SettingsRow title="全局" dense>
        <template #badge>
          <StatusBadge tone="accent">可编辑</StatusBadge>
        </template>
        <template #description>
          <code class="path">{{ payload?.path || '—' }}</code>
        </template>
      </SettingsRow>
      <SettingsRow
        v-for="file in projectFiles"
        :key="file"
        title="项目"
        dense
        data-testid="hooks-project-source"
      >
        <template #badge><StatusBadge>只读</StatusBadge></template>
        <template #description>
          <code class="path">{{ file }}</code>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      v-if="loadErrors.length"
      title="加载错误"
      :description="`${loadErrors.length} 个配置文件未能加载`"
    >
      <SettingsRow
        v-for="(item, index) in loadErrors"
        :key="`${index}:${item}`"
        dense
      >
        <template #description>
          <span class="error-text">{{ item }}</span>
        </template>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup
      title="事件"
      :description="`共 ${total} 个命令 hook`"
      data-testid="hooks-events"
    >
      <ul class="event-grid">
        <li
          v-for="row in eventRows"
          :key="row.eventName"
          class="event-row"
          :data-event="row.eventName"
        >
          <span class="event-name">{{ row.eventName }}</span>
          <StatusBadge :tone="row.count ? 'ok' : 'neutral'" mono>
            {{ row.count }}
          </StatusBadge>
        </li>
      </ul>
    </SettingsGroup>

    <SettingsGroup
      title="hooks.json"
      description="编辑全局配置；保存前自动校验，⌘S 保存"
    >
      <template #actions>
        <StatusBadge v-if="dirty" tone="warn" dot>未保存</StatusBadge>
      </template>
      <div class="editor-block">
        <CodeEditor
          v-model="draft"
          language="json"
          aria-label="hooks.json"
          :min-lines="14"
          :max-lines="26"
          :invalid="validationState === 'invalid'"
          @update:model-value="onDraftInput"
          @save="save"
        />

        <ul v-if="issues.length" class="issues" aria-label="校验问题">
          <li v-for="(issue, index) in issues" :key="index" class="issue">
            <code class="issue-kind">{{ issue.kind }}</code>
            <span>{{ issue.text }}</span>
          </li>
        </ul>

        <div class="action-row">
          <div
            class="validation"
            data-testid="hooks-validation"
            :data-state="validationState"
            aria-live="polite"
          >
            <StatusBadge v-if="validationState === 'valid'" tone="ok" dot>
              配置有效
            </StatusBadge>
            <StatusBadge
              v-else-if="validationState === 'invalid'"
              tone="error"
              dot
            >
              校验未通过
            </StatusBadge>
            <span v-else class="muted">尚未校验</span>
          </div>
          <div class="actions">
            <Button
              size="sm"
              variant="outline"
              :disabled="saving || !dirty"
              @click="resetDraft"
            >
              还原
            </Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="saving"
              @click="validate"
            >
              校验
            </Button>
            <Button
              size="sm"
              variant="primary"
              :disabled="saving || !dirty"
              @click="save"
            >
              {{ saving ? '保存中…' : '保存' }}
            </Button>
          </div>
        </div>

        <p v-if="metadata" class="hint">
          Matcher：{{ metadata.matcher.literal }}；{{ metadata.matcher.regex }}
          <template v-if="metadata.substitutions.length">
            · 变量：{{ metadata.substitutions.join('、') }}
          </template>
        </p>
      </div>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.hooks-config {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.path {
  font: var(--font-code-small);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}

.error-text {
  color: rgb(var(--state-error-label));
}

/* Event rows: name left, count badge right; auto-fill puts them in two
   columns inside the 564px column and one when the section is narrower. */
.event-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  column-gap: var(--space-6);
  margin: 0;
  padding: var(--space-1) 0 0;
  list-style: none;
}

.event-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2-5) 0;
  border-bottom: 1px solid var(--border-l2);
}

.event-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  color: rgb(var(--label-primary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  padding-top: var(--space-3);
}

.issues {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
}

.issue {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}

.issue + .issue {
  border-top: 1px solid var(--border-l1);
}

.issue-kind {
  flex: none;
  font: var(--font-code-small);
  color: rgb(var(--state-error-label));
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.validation {
  display: flex;
  align-items: center;
  min-width: 0;
}

.muted {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.hint {
  margin: 0;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
  overflow-wrap: anywhere;
}
</style>
