<script setup lang="ts">
/**
 * RecordDetail — inspector body of one selected record, per active tab:
 * - request header (SYSTEM): System Prompt (markdown) / Tools / Diff;
 * - compacted: Summary / Raw Output;
 * - user / context / assistant: Summary / Preview / Raw / Source;
 * - tool / subtool: Summary / Payload / Result / Schema / Timing.
 * The Summary tab adds hierarchy links (request, assistant message, parent
 * tool), Emperor facts (subagent / job / workflow / notices / event type)
 * with a child-session link, and a notice when the wire truncated the
 * record's payload.
 *
 * Props: controller; record (live content); tab.
 * Emits: open-subagent(sessionId).
 */
import { computed, ref, watch } from 'vue'
import {
  formatElapsedSeconds,
  isTrajectoryMarkdownRecord,
  trajectoryMessageSourceLabel,
  trajectoryParentRecords,
  trajectoryRecordState,
  trajectoryRequestKey,
  trajectoryStatusLabel,
  type TrajectoryDetailTab,
  type TrajectoryLedgerRecord,
} from '../../../trajectory/model'
import { fetchSessionEvent } from '../../../api/sessions'
import DsChevronRight from '../../icons/ds/DsChevronRight.vue'
import JsonTree from '../../ui/JsonTree.vue'
import { formatTokens, type InspectorRow } from '../trajectoryFormat'
import type { TrajectoryController } from '../useTrajectory'
import InspectorMarkdown from './InspectorMarkdown.vue'
import InspectorRows from './InspectorRows.vue'
import MarkdownRecordContent from './MarkdownRecordContent.vue'
import OverviewSection from './OverviewSection.vue'
import PromptDiff from './PromptDiff.vue'
import RecordPayload from './RecordPayload.vue'
import RecordSchema from './RecordSchema.vue'
import RecordTiming from './RecordTiming.vue'
import ToolCatalog from './ToolCatalog.vue'

const props = defineProps<{
  controller: TrajectoryController
  record: TrajectoryLedgerRecord
  tab: TrajectoryDetailTab
}>()
const emit = defineEmits<{ 'open-subagent': [sessionId: string] }>()

const c = props.controller
const cell = computed(() => props.record.cell)
const thinkingExpanded = ref(false)
watch(
  () => cell.value.index,
  () => (thinkingExpanded.value = false),
)

const state = computed(() => trajectoryRecordState(cell.value))
const markdown = computed(() => isTrajectoryMarkdownRecord(cell.value))
const parents = computed(() =>
  trajectoryParentRecords(c.records.value, props.record),
)
const requestNumber = computed(() =>
  cell.value.kind === 'message'
    ? c.requestDisplayNumbers.value.get(
        trajectoryRequestKey(props.record.turn, props.record.group),
      )
    : undefined,
)
const requestTarget = computed(() => {
  if (requestNumber.value === undefined) return undefined
  const info = c.requestNumbers.value.find(
    (request) => request.number === requestNumber.value,
  )
  return {
    turn: props.record.turn,
    group: props.record.group,
    ...(info?.seq === undefined ? {} : { seq: info.seq }),
  }
})
const hasHierarchy = computed(
  () =>
    requestTarget.value !== undefined ||
    parents.value.message !== undefined ||
    parents.value.tool !== undefined,
)

const statusRows = computed((): InspectorRow[] => {
  const rows: InspectorRow[] = [
    {
      label: 'Status',
      value: trajectoryStatusLabel(state.value),
      ...(state.value === 'error' ? { tone: 'error' as const } : {}),
    },
  ]
  const value = cell.value
  if (value.kind === 'message') {
    rows.push({
      label: 'Tokens',
      value: value.output === undefined ? '—' : formatTokens(value.output),
    })
    if (value.think !== undefined)
      rows.push({
        label: 'Reasoning',
        value: formatTokens(value.think),
        detail: true,
      })
    if (value.output !== undefined && value.think !== undefined)
      rows.push({
        label: 'Content',
        value: formatTokens(Math.max(0, value.output - value.think)),
        detail: true,
      })
  }
  if (value.kind === 'user' || value.kind === 'context')
    rows.push({
      label: 'Duration',
      value: formatElapsedSeconds(value.timeSeconds),
    })
  if (value.eventType !== undefined)
    rows.push({ label: 'Event', value: value.eventType })
  return rows
})

/** Emperor enrichment rows (subagent / job / workflow / notices). */
const factRows = computed((): InspectorRow[] => {
  const value = cell.value
  const rows: InspectorRow[] = []
  if (value.subagent !== undefined) {
    const fact = value.subagent
    rows.push({
      label: 'Subagent',
      value: fact.description || fact.childSessionId,
    })
    rows.push({
      label: 'Mode',
      value: `${fact.mode}${fact.background ? ' · background' : ''}`,
      detail: true,
    })
    rows.push({
      label: 'State',
      value:
        fact.status === 'running'
          ? 'Running'
          : `Settled${fact.stopReason === undefined ? '' : ` · ${fact.stopReason}`}`,
      detail: true,
    })
  }
  if (value.job !== undefined) {
    const job = value.job
    rows.push({
      label: 'Job',
      value: `${job.jobId}${job.kind ? ` · ${job.kind}` : ''}`,
    })
    rows.push({
      label: 'State',
      value: `${job.status}${job.exitCode === undefined ? '' : ` · exit ${job.exitCode}`}`,
      detail: true,
      ...(job.status === 'failed' ? { tone: 'error' as const } : {}),
    })
  }
  if (value.workflow !== undefined) {
    const run = value.workflow
    rows.push({
      label: run.tool === 'ralph' ? 'Ralph' : 'Workflow',
      value: run.name,
    })
    rows.push({
      label: 'State',
      value: run.status,
      detail: true,
      ...(run.status === 'error' ? { tone: 'error' as const } : {}),
    })
    if (run.phases.length > 0)
      rows.push({
        label: 'Phases',
        value: run.phases.join(' → '),
        detail: true,
      })
  }
  for (const notice of value.notices ?? []) {
    if (notice.kind === 'fallback')
      rows.push({
        label: 'Fallback',
        value: `${notice.from} → ${notice.to} · ${notice.code}`,
        tone: 'error',
      })
    else
      rows.push({
        label: 'Cost cap',
        value: `$${(notice.spentUsdNanos / 1e9).toFixed(4)} spent of $${(notice.capUsdNanos / 1e9).toFixed(4)}`,
        tone: 'error',
      })
  }
  return rows
})

const truncation = computed(() => {
  const parts = [
    ...(cell.value.argsTruncated === true ? ['arguments'] : []),
    ...(cell.value.resultTruncated === true ? ['result'] : []),
  ]
  return parts.length === 0
    ? null
    : `The ${parts.join(' and ')} of this call were truncated for transport; the session log keeps the full payload.`
})

/** Untruncated payloads fetched on demand (`sessions.event`). */
const fullPayload = ref<{ args?: string; result?: string } | null>(null)
const fullLoading = ref(false)
const fullError = ref('')
watch(
  () => cell.value.index,
  () => {
    fullPayload.value = null
    fullError.value = ''
  },
)

function resultText(event: unknown): string {
  const data = (event as { data?: { message?: { content?: unknown } } }).data
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks as Array<Record<string, unknown>>) {
    const inner = Array.isArray(block.content) ? block.content : [block]
    for (const item of inner as Array<Record<string, unknown>>)
      if (typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

async function loadFullPayload(): Promise<void> {
  const sessionId = c.sessionId
  fullLoading.value = true
  fullError.value = ''
  try {
    const next: { args?: string; result?: string } = {}
    if (cell.value.argsEventSeq !== undefined) {
      const event = await fetchSessionEvent(sessionId, cell.value.argsEventSeq)
      const args = (event as { data?: { arguments?: unknown } }).data?.arguments
      if (typeof args === 'string') next.args = args
    }
    if (cell.value.resultEventSeq !== undefined) {
      const event = await fetchSessionEvent(
        sessionId,
        cell.value.resultEventSeq,
      )
      next.result = resultText(event)
    }
    fullPayload.value = next
  } catch (error) {
    fullError.value = error instanceof Error ? error.message : String(error)
  } finally {
    fullLoading.value = false
  }
}

const canLoadFull = computed(
  () =>
    cell.value.argsEventSeq !== undefined ||
    cell.value.resultEventSeq !== undefined,
)

const sourceData = computed(() => {
  const source = cell.value.messageSource
  return typeof source === 'object' && source !== null
    ? source
    : { value: source }
})

function openCall(callId: string): void {
  c.openCallSummary(callId)
}
</script>

<template>
  <div class="traj-record-detail" :data-tab="tab">
    <p
      v-if="
        truncation !== null &&
        (tab === 'overview' || tab === 'input' || tab === 'output')
      "
      class="notice"
      data-wire-truncated
    >
      {{ truncation }}
      <button
        v-if="canLoadFull && fullPayload === null"
        type="button"
        class="load-full"
        data-load-full
        :disabled="fullLoading"
        @click="loadFullPayload"
      >
        {{ fullLoading ? '加载中…' : '加载完整内容' }}
      </button>
      <span v-if="fullError" class="load-error">{{ fullError }}</span>
    </p>
    <div
      v-if="fullPayload !== null && (tab === 'input' || tab === 'output')"
      class="full-payload"
      data-full-payload
    >
      <pre v-if="tab === 'input' && fullPayload.args !== undefined">{{
        fullPayload.args
      }}</pre>
      <pre v-if="tab === 'output' && fullPayload.result !== undefined">{{
        fullPayload.result
      }}</pre>
    </div>

    <!-- request header -->
    <template v-if="cell.kind === 'system' && cell.promptDetail !== undefined">
      <template v-if="tab === 'system-prompt'">
        <p v-if="cell.promptDetail.system === ''" class="no-payload">
          No system prompt in this request
        </p>
        <InspectorMarkdown v-else :text="cell.promptDetail.system" />
      </template>
      <ToolCatalog
        v-else-if="tab === 'tools'"
        :tools="cell.promptDetail.tools"
      />
      <PromptDiff
        v-else-if="tab === 'diff' && cell.previousPromptDetail !== undefined"
        :before="cell.previousPromptDetail"
        :after="cell.promptDetail"
      />
    </template>

    <!-- compaction -->
    <template v-else-if="cell.kind === 'compacted'">
      <template v-if="tab === 'overview'">
        <InspectorRows
          :rows="[
            {
              label: 'Status',
              value: trajectoryStatusLabel(state),
              ...(state === 'error' ? { tone: 'error' as const } : {}),
            },
            {
              label: 'Duration',
              value: formatElapsedSeconds(cell.timeSeconds),
            },
            { label: 'Tokens', value: '—' },
          ]"
        />
        <MarkdownRecordContent
          v-if="cell.outputDetail !== undefined"
          v-model:thinking-expanded="thinkingExpanded"
          :record="record"
          rendered
          @open-call="openCall"
        />
      </template>
      <MarkdownRecordContent
        v-else-if="tab === 'raw'"
        :record="record"
        :rendered="false"
        @open-call="openCall"
      />
    </template>

    <!-- user / context / assistant / tool -->
    <template v-else>
      <template v-if="tab === 'overview'">
        <InspectorRows :rows="[...statusRows, ...factRows]">
          <template #before>
            <div v-if="cell.messageSource !== undefined">
              <dt>Source</dt>
              <dd class="links">
                <button
                  type="button"
                  class="nav-link"
                  @click="c.activateTab('source')"
                >
                  <span>{{
                    trajectoryMessageSourceLabel(cell.messageSource)
                  }}</span>
                  <DsChevronRight :size="11" class="nav-icon" />
                </button>
              </dd>
            </div>
            <div v-if="hasHierarchy">
              <dt>
                {{ requestTarget !== undefined ? 'Source' : 'Hierarchy' }}
              </dt>
              <dd class="links">
                <button
                  v-if="requestTarget !== undefined"
                  type="button"
                  class="nav-link"
                  data-link="request"
                  @click="c.selectRequest(requestTarget)"
                >
                  <span>Request #{{ requestNumber }}</span>
                  <DsChevronRight :size="11" class="nav-icon" />
                </button>
                <button
                  v-if="parents.message !== undefined"
                  type="button"
                  class="nav-link"
                  data-link="message"
                  @click="c.openRecordSummary(parents.message)"
                >
                  <span>Assistant Message</span>
                  <DsChevronRight :size="11" class="nav-icon" />
                </button>
                <button
                  v-if="parents.tool !== undefined"
                  type="button"
                  class="nav-link"
                  data-link="tool"
                  @click="c.openRecordSummary(parents.tool)"
                >
                  <span>Tool Call</span>
                  <DsChevronRight :size="11" class="nav-icon" />
                </button>
              </dd>
            </div>
          </template>
          <div v-if="cell.childSessionId !== undefined">
            <dt>Session</dt>
            <dd class="links">
              <button
                type="button"
                class="nav-link"
                data-link="child-session"
                @click="emit('open-subagent', cell.childSessionId)"
              >
                <span>Open child session</span>
                <DsChevronRight :size="11" class="nav-icon" />
              </button>
            </dd>
          </div>
        </InspectorRows>
        <div class="sections">
          <OverviewSection
            v-if="markdown"
            label="Preview"
            @open="c.activateTab('rendered')"
          >
            <MarkdownRecordContent
              v-model:thinking-expanded="thinkingExpanded"
              :record="record"
              rendered
              preview
              @open-call="openCall"
            />
          </OverviewSection>
          <template v-else>
            <OverviewSection
              v-if="cell.inputDetail"
              label="Payload"
              @open="c.activateTab('input')"
            >
              <RecordPayload :record="record" direction="input" preview />
            </OverviewSection>
            <OverviewSection
              v-if="cell.outputDetail"
              label="Result"
              @open="c.activateTab('output')"
            >
              <RecordPayload :record="record" direction="output" preview />
            </OverviewSection>
            <OverviewSection label="Schema" @open="c.activateTab('schema')">
              <RecordSchema :record="record" preview />
            </OverviewSection>
          </template>
          <OverviewSection
            v-if="requestTarget !== undefined"
            label="Request Timing"
            @open="c.selectRequest(requestTarget, 'timing')"
          >
            <RecordTiming :record="record" dense />
          </OverviewSection>
          <OverviewSection
            v-if="cell.kind === 'tool' || cell.kind === 'subtool'"
            label="Timing"
            @open="c.activateTab('timing')"
          >
            <RecordTiming :record="record" dense />
          </OverviewSection>
        </div>
      </template>
      <MarkdownRecordContent
        v-else-if="tab === 'rendered'"
        v-model:thinking-expanded="thinkingExpanded"
        :record="record"
        rendered
        @open-call="openCall"
      />
      <MarkdownRecordContent
        v-else-if="tab === 'raw'"
        :record="record"
        :rendered="false"
        @open-call="openCall"
      />
      <template v-else-if="tab === 'source'">
        <p v-if="cell.messageSource === undefined" class="no-payload">
          Source not recorded
        </p>
        <JsonTree v-else :value="sourceData" :expand-depth="3" />
      </template>
      <RecordPayload
        v-else-if="tab === 'input'"
        :record="record"
        direction="input"
      />
      <RecordPayload
        v-else-if="tab === 'output'"
        :record="record"
        direction="output"
      />
      <RecordSchema v-else-if="tab === 'schema'" :record="record" />
      <RecordTiming v-else-if="tab === 'timing'" :record="record" />
    </template>
  </div>
</template>

<style scoped>
.traj-record-detail {
  min-height: 0;
}

.no-payload {
  margin: 0;
  padding: var(--space-4) var(--space-3-5);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
}

.load-full {
  margin-left: var(--space-2);
  color: rgb(var(--accent-strong));
  text-decoration: underline;
  font: inherit;
}
.load-full:disabled {
  opacity: 0.6;
}
.load-error {
  margin-left: var(--space-2);
  color: rgb(var(--danger));
}
.full-payload pre {
  margin: var(--space-2) var(--space-3-5) 0;
  padding: var(--space-2) var(--space-2-5);
  max-height: 60vh;
  overflow: auto;
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font: var(--font-code-small);
  white-space: pre-wrap;
  word-break: break-word;
}
.notice {
  margin: var(--space-2) var(--space-3-5) 0;
  padding: var(--space-1-5) var(--space-2-5);
  border: 1px solid color-mix(in srgb, rgb(var(--approval)) 40%, transparent);
  border-radius: var(--radius-row);
  color: rgb(var(--approval-strong));
  background: rgb(var(--approval-soft));
  font: var(--font-xxs);
}

.links {
  display: flex;
  gap: var(--space-3-5);
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

.nav-link:hover,
.nav-link:focus-visible {
  color: rgb(var(--label-primary));
}

.nav-link:focus-visible {
  outline: 1px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.nav-icon {
  color: rgb(var(--label-caption));
}

.nav-link:hover .nav-icon {
  color: rgb(var(--label-primary));
}

.sections {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--space-3);
}
</style>
