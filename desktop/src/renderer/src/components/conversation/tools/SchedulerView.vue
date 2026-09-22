<script setup lang="ts">
/** SchedulerView — scheduler action facts (schedule, prompt) + result. */
import { computed } from 'vue'
import type { ToolChatData } from '../../../conversation/types'
import { argsOf, resultText } from './toolModel'

const props = defineProps<{ data: ToolChatData }>()

const FIELD_LABEL: Record<string, string> = {
  job_id: '任务 ID',
  name: '名称',
  message: '提示词',
  at: '执行时间',
  every_seconds: '间隔（秒）',
  cron_expr: 'Cron',
  tz: '时区',
  deliver: '显示结果',
  delete_after_run: '运行后删除',
}

const fields = computed(() =>
  Object.entries(argsOf(props.data)).flatMap(([key, value]) =>
    key === 'action' || value === undefined || value === null
      ? []
      : [
          {
            key,
            label: FIELD_LABEL[key] ?? key,
            value:
              typeof value === 'boolean'
                ? value
                  ? '是'
                  : '否'
                : String(value),
          },
        ],
  ),
)
const output = computed(() => resultText(props.data))
</script>

<template>
  <div class="scheduler-view">
    <dl v-if="fields.length" class="fields">
      <template v-for="field in fields" :key="field.key">
        <dt>{{ field.label }}</dt>
        <dd>{{ field.value }}</dd>
      </template>
    </dl>
    <div
      v-if="output"
      class="output"
      :data-error="data.result?.isError || undefined"
    >
      {{ output }}
    </div>
  </div>
</template>

<style scoped>
.scheduler-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  background: rgb(var(--code-block-bg));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.fields {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-0-5) var(--space-3);
  margin: 0;
}

dt {
  color: rgb(var(--label-tertiary));
}

dd {
  margin: 0;
  min-width: 0;
  color: rgb(var(--label-secondary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.output {
  max-height: 160px;
  overflow-y: auto;
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-l2);
  font: var(--font-code-small);
  color: rgb(var(--label-secondary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.output[data-error] {
  color: rgb(var(--danger));
}
</style>
