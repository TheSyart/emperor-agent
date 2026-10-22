<script setup lang="ts">
/**
 * RequestDetail — inspector body of one selected provider request (a
 * ledger request dot): Summary (status, provider / model, tool-call counts,
 * error / retry, result link + Options / Usage / Timing previews), Options
 * (request config JSON), Usage (this request and session cumulative: input
 * with cache read / write split, output with reasoning split) and Timing
 * (Started, duration, TTFT, decode, tok/s; assistant step timing).
 *
 * Props: controller; inspection (RequestInspection); tab.
 */
import { computed } from 'vue'
import {
  trajectoryStatusLabel,
  type TrajectoryDetailTab,
} from '../../../trajectory/model'
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'
import JsonTree from '../../ui/JsonTree.vue'
import { usageRows, type InspectorRow } from '../trajectoryFormat'
import type { TrajectoryController } from '../useTrajectory'
import InspectorRows from './InspectorRows.vue'
import OverviewSection from './OverviewSection.vue'
import RecordTiming from './RecordTiming.vue'
import StartedAt from './StartedAt.vue'
import { requestTimingRows, type RequestInspection } from './inspectorModel'

const props = defineProps<{
  controller: TrajectoryController
  inspection: RequestInspection
  tab: TrajectoryDetailTab
}>()

const c = props.controller
const info = computed(() => props.inspection.info)
const summaryRows = computed((): InspectorRow[] => {
  const inspection = props.inspection
  const rows: InspectorRow[] = [
    {
      label: '状态',
      value: trajectoryStatusLabel(inspection.state),
      ...(inspection.state === 'error' ? { tone: 'error' as const } : {}),
    },
  ]
  if (inspection.compaction) rows.push({ label: '用途', value: 'Compaction' })
  const provider = info.value?.provider ?? info.value?.requestConfig?.provider
  const model = info.value?.model ?? info.value?.requestConfig?.model
  if (provider !== undefined) rows.push({ label: '提供方', value: provider })
  if (model !== undefined) rows.push({ label: '模型', value: model })
  if (info.value?.contextWindow !== undefined)
    rows.push({
      label: '上下文',
      value: `${info.value.contextWindow.toLocaleString('en-US')} tok`,
    })
  rows.push({ label: '工具调用', value: String(inspection.toolCalls) })
  if (inspection.subtoolCalls > 0)
    rows.push({
      label: '子工具调用',
      value: String(inspection.subtoolCalls),
    })
  if (info.value?.error !== undefined)
    rows.push({ label: '错误', value: info.value.error, tone: 'error' })
  for (const notice of info.value?.notices ?? [])
    if (notice.kind === 'fallback')
      rows.push({
        label: '回退',
        value: `${notice.from} → ${notice.to}`,
        tone: 'error',
      })
  return rows
})
const timingRows = computed(() => requestTimingRows(props.inspection))
const requestUsage = computed(() => usageRows(props.inspection.usage))
const cumulativeUsage = computed(() =>
  usageRows(props.inspection.cumulativeUsage),
)
</script>

<template>
  <div class="traj-request-detail" :data-tab="tab">
    <template v-if="tab === 'overview'">
      <InspectorRows :rows="summaryRows">
        <div v-if="inspection.result !== undefined">
          <dt>结果</dt>
          <dd>
            <button
              type="button"
              class="nav-link"
              data-link="result"
              @click="c.openRecordSummary(inspection.result)"
            >
              <span>{{ inspection.compaction ? '已压缩' : '助手消息' }}</span>
              <DsChevronRight :size="12" class="nav-icon" />
            </button>
          </dd>
        </div>
      </InspectorRows>
      <OverviewSection
        v-if="inspection.options !== undefined"
        label="选项"
        @open="c.activateTab('options')"
      >
        <JsonTree :value="inspection.options" />
      </OverviewSection>
      <OverviewSection label="用量" @open="c.activateTab('usage')">
        <p v-if="requestUsage.length === 0" class="no-payload">未报告用量</p>
        <InspectorRows v-else :rows="requestUsage" dense />
      </OverviewSection>
      <OverviewSection label="计时" @open="c.activateTab('timing')">
        <InspectorRows :rows="timingRows" dense>
          <template #before>
            <StartedAt
              :timestamp="info?.startedAt ?? inspection.anchor?.cell.startedAt"
            />
          </template>
        </InspectorRows>
      </OverviewSection>
    </template>
    <template v-else-if="tab === 'options'">
      <p v-if="inspection.options === undefined" class="no-payload">
        未记录选项
      </p>
      <JsonTree v-else :value="inspection.options" :expand-depth="3" />
    </template>
    <div v-else-if="tab === 'usage'" class="usage" data-inspector-usage>
      <section class="usage-group">
        <h4 class="usage-heading">本次请求</h4>
        <p v-if="requestUsage.length === 0" class="no-payload">未报告用量</p>
        <InspectorRows v-else :rows="requestUsage" dense />
      </section>
      <section class="usage-group">
        <h4 class="usage-heading">会话累计</h4>
        <p v-if="cumulativeUsage.length === 0" class="no-payload">未报告用量</p>
        <InspectorRows v-else :rows="cumulativeUsage" dense />
      </section>
    </div>
    <template v-else-if="tab === 'timing'">
      <InspectorRows :rows="timingRows" data-inspector-timing>
        <template #before>
          <StartedAt
            :timestamp="info?.startedAt ?? inspection.anchor?.cell.startedAt"
          />
        </template>
      </InspectorRows>
      <template
        v-if="inspection.assistant?.cell.assistantMetrics !== undefined"
      >
        <h4 class="usage-heading">助手步骤</h4>
        <RecordTiming :record="inspection.assistant" dense />
      </template>
    </template>
  </div>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
  color: rgb(var(--text-3));
  font: var(--font-xs);
}

.usage {
  padding: var(--space-1) 0 var(--space-2-5);
}

.usage-group + .usage-group {
  margin-top: var(--space-2);
}

.usage-heading {
  margin: 0;
  padding: var(--space-1) var(--space-3-5) 1px;
  color: rgb(var(--text-2));
  font: var(--weight-semibold) var(--fs-xs) / var(--lh-xs) var(--font-sans);
  user-select: none;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 0;
  border: 0;
  color: rgb(var(--text-2));
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.nav-link:hover {
  color: rgb(var(--text-1));
}

.nav-icon {
  color: rgb(var(--text-3));
}
</style>
