<script setup lang="ts">
/**
 * Hooks › 测试: a vertical form (event + matcher query → 匹配) over the
 * matched commands. 「执行」 on a match opens an inline confirmation naming
 * the command; only 「确认执行」 calls hooks.testRun (`confirmExecution`).
 * The run result shows decision / exit code / duration badges over the raw
 * JSON. Unsaved editor content is matched and run as-is.
 */
import { computed } from 'vue'
import Button from '../../ui/Button.vue'
import { DsTerminal, DsWarning } from '../../icons/ds'
import {
  EmptyState,
  Field,
  Select,
  SettingsGroup,
  SettingsRow,
  StatusBadge,
  TextField,
  type SelectOption,
} from '../ui'
import { useHooksController } from './hooksController'
import {
  hookExitTone,
  hookMatchQueryLabel,
  hookOutcomeTone,
} from './hooksModel'

const {
  testing,
  dirty,
  events,
  selectedEventName,
  selectedEvent,
  matchQuery,
  matchResult,
  pendingRun,
  testResult,
  testMatch,
  requestRun,
  cancelRun,
  confirmRun,
} = useHooksController()

const eventOptions = computed<SelectOption[]>(() =>
  events.value.map((event) => ({
    value: event.eventName,
    label: event.eventName,
    description: event.matcher ? `matcher：${event.matcher}` : '无 matcher',
  })),
)

const resultJson = computed(() =>
  testResult.value ? JSON.stringify(testResult.value, null, 2) : '',
)
</script>

<template>
  <div class="hooks-test">
    <SettingsGroup
      title="匹配测试"
      :description="
        dirty ? '使用编辑器中未保存的内容匹配。' : '使用已保存的 hooks.json。'
      "
      variant="form"
    >
      <Field label="事件">
        <Select
          v-model="selectedEventName"
          :options="eventOptions"
          placeholder="选择事件"
          block
          data-testid="hooks-test-event"
        />
      </Field>
      <Field
        label="匹配查询"
        :hint="hookMatchQueryLabel(selectedEvent?.matcher)"
      >
        <TextField
          v-model="matchQuery"
          :disabled="!selectedEvent?.matcher"
          monospace
          spellcheck="false"
          placeholder="Write"
          @keydown.enter="testMatch"
        />
      </Field>
      <div class="form-actions">
        <Button
          size="sm"
          variant="primary"
          :disabled="testing || !selectedEventName"
          @click="testMatch"
        >
          匹配
        </Button>
      </div>
    </SettingsGroup>

    <SettingsGroup
      title="匹配结果"
      :description="
        matchResult ? `${matchResult.items.length} 条命令命中` : undefined
      "
      data-testid="hooks-matches"
    >
      <EmptyState
        v-if="!matchResult"
        class="result-empty"
        title="尚未运行"
        description="选择事件并填写匹配查询后点「匹配」。"
        compact
      />
      <EmptyState
        v-else-if="!matchResult.items.length"
        class="result-empty"
        title="无匹配命令"
        compact
      />
      <template v-else>
        <SettingsRow
          v-for="item in matchResult.items"
          :key="item.index"
          dense
          class="match-row"
          data-testid="hooks-match"
        >
          <template #title>
            <code class="command">{{ item.command }}</code>
          </template>
          <template #description>
            {{ item.matcher || '*' }} · {{ item.file }}
            <template v-if="item.timeoutSec">
              · {{ item.timeoutSec }}s</template
            >
          </template>
          <Button
            size="sm"
            variant="outline"
            :title="`执行 ${item.command}`"
            :disabled="testing"
            @click="requestRun(item)"
          >
            <template #icon><DsTerminal :size="14" /></template>
            执行
          </Button>
        </SettingsRow>
      </template>
      <ul v-if="matchResult?.errors?.length" class="match-errors">
        <li v-for="(item, index) in matchResult.errors" :key="index">
          {{ item }}
        </li>
      </ul>

      <div
        v-if="pendingRun"
        class="confirm"
        role="alertdialog"
        aria-label="确认执行 Hook 命令"
        data-testid="hooks-run-confirm"
      >
        <div class="confirm-text">
          <DsWarning :size="16" class="confirm-glyph" />
          <span
            >将在本机执行此 Hook 命令，并把测试 payload 写入它的 stdin。</span
          >
        </div>
        <code class="confirm-command">{{ pendingRun.command }}</code>
        <div class="confirm-actions">
          <Button size="sm" variant="ghost" @click="cancelRun">取消</Button>
          <Button
            size="sm"
            variant="primary"
            :disabled="testing"
            @click="confirmRun"
          >
            {{ testing ? '执行中…' : '确认执行' }}
          </Button>
        </div>
      </div>
    </SettingsGroup>

    <SettingsGroup
      v-if="testResult"
      title="运行结果"
      data-testid="hooks-test-result"
    >
      <div class="result">
        <div class="result-badges">
          <StatusBadge :tone="hookOutcomeTone(testResult.decision)" dot>
            decision {{ testResult.decision || '—' }}
          </StatusBadge>
          <StatusBadge :tone="hookExitTone(testResult.exitCode)" mono>
            exit {{ testResult.exitCode ?? '—' }}
          </StatusBadge>
          <StatusBadge mono>{{ testResult.durationMs }}ms</StatusBadge>
        </div>
        <pre class="result-json">{{ resultJson }}</pre>
      </div>
    </SettingsGroup>
  </div>
</template>

<style scoped>
.hooks-test {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.result-empty {
  margin-top: var(--space-3);
}

.command {
  font: var(--font-code-small);
  color: rgb(var(--label-primary));
  overflow-wrap: anywhere;
}

.match-errors {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}

/* Inline confirmation: the one place a test run can start. */
.confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid rgb(var(--state-warn) / 0.4);
  border-radius: var(--radius-card);
  background: rgb(var(--state-warn-soft));
}

.confirm-text {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--state-warn-label));
}

.confirm-glyph {
  flex: none;
  margin-top: var(--space-0-5);
}

.confirm-command {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
  color: rgb(var(--code-fg));
  overflow-wrap: anywhere;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  min-width: 0;
  padding-top: var(--space-3);
}

.result-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.result-json {
  max-height: 280px;
  margin: 0;
  overflow: auto;
  padding: var(--space-2-5) var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--code-fg));
  white-space: pre;
}
</style>
