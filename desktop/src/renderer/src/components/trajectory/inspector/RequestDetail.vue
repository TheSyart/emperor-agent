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
      label: 'Status',
      value: trajectoryStatusLabel(inspection.state),
      ...(inspection.state === 'error' ? { tone: 'error' as const } : {}),
    },
  ]
  if (inspection.compaction)
    rows.push({ label: 'Purpose', value: 'Compaction' })
  const provider = info.value?.provider ?? info.value?.requestConfig?.provider
  const model = info.value?.model ?? info.value?.requestConfig?.model
  if (provider !== undefined) rows.push({ label: 'Provider', value: provider })
  if (model !== undefined) rows.push({ label: 'Model', value: model })
  if (info.value?.contextWindow !== undefined)
    rows.push({
      label: 'Context',
      value: `${info.value.contextWindow.toLocaleString('en-US')} tok`,
    })
  rows.push({ label: 'Tool calls', value: String(inspection.toolCalls) })
  if (inspection.subtoolCalls > 0)
    rows.push({
      label: 'Subtool calls',
      value: String(inspection.subtoolCalls),
    })
  if (info.value?.error !== undefined)
    rows.push({ label: 'Error', value: info.value.error, tone: 'error' })
  for (const notice of info.value?.notices ?? [])
    if (notice.kind === 'fallback')
      rows.push({
        label: 'Fallback',
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
          <dt>Result</dt>
          <dd>
            <button
              type="button"
              class="nav-link"
              data-link="result"
              @click="c.openRecordSummary(inspection.result)"
            >
              <span>{{
                inspection.compaction ? 'Compacted' : 'Assistant Message'
              }}</span>
              <DsChevronRight :size="11" class="nav-icon" />
            </button>
          </dd>
        </div>
      </InspectorRows>
      <OverviewSection
        v-if="inspection.options !== undefined"
        label="Options"
        @open="c.activateTab('options')"
      >
        <JsonTree :value="inspection.options" />
      </OverviewSection>
      <OverviewSection label="Usage" @open="c.activateTab('usage')">
        <p v-if="requestUsage.length === 0" class="no-payload">
          Usage not reported
        </p>
        <InspectorRows v-else :rows="requestUsage" dense />
      </OverviewSection>
      <OverviewSection label="Timing" @open="c.activateTab('timing')">
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
        Options not recorded
      </p>
      <JsonTree v-else :value="inspection.options" :expand-depth="3" />
    </template>
    <div v-else-if="tab === 'usage'" class="usage" data-inspector-usage>
      <section class="usage-group">
        <h4 class="usage-heading">This request</h4>
        <p v-if="requestUsage.length === 0" class="no-payload">
          Usage not reported
        </p>
        <InspectorRows v-else :rows="requestUsage" dense />
      </section>
      <section class="usage-group">
        <h4 class="usage-heading">Session cumulative</h4>
        <p v-if="cumulativeUsage.length === 0" class="no-payload">
          Usage not reported
        </p>
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
        <h4 class="usage-heading">Assistant step</h4>
        <RecordTiming :record="inspection.assistant" dense />
      </template>
    </template>
  </div>
</template>

<style scoped>
.no-payload {
  margin: 0;
  padding: var(--space-1-5) var(--space-3-5) var(--space-2);
  color: rgb(var(--label-tertiary));
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
  color: rgb(var(--label-secondary));
  font: 600 var(--fs-xs) / var(--lh-xs) var(--font-sans);
  user-select: none;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 0;
  border: 0;
  color: rgb(var(--label-secondary));
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.nav-link:hover {
  color: rgb(var(--label-primary));
}

.nav-icon {
  color: rgb(var(--label-caption));
}
</style>
