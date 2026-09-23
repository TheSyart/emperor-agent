<script setup lang="ts">
/**
 * InspectorPanel — the trajectory inspector column over a shared
 * controller, sidebar-style: a 42px header (「详情」, then the kind tag /
 * request dot + location of the selection, and the collapse button), the
 * 34px tab strip (tab set per selection kind) and the scrolling tab body.
 * Collapsing only hides the column (the selection stays); with nothing
 * selected the body shows an empty hint.
 *
 * Props: controller.
 * Emits: open-subagent(sessionId), collapse.
 */
import { PanelRightClose } from 'lucide-vue-next'
import { computed } from 'vue'
import type { TrajectoryDetailTab } from '../../../trajectory/model'
import IconButton from '../../ui/IconButton.vue'
import Tabs from '../../ui/Tabs.vue'
import TrajectoryKindTag from '../TrajectoryKindTag.vue'
import type { TrajectoryController } from '../useTrajectory'
import RecordDetail from './RecordDetail.vue'
import RequestDetail from './RequestDetail.vue'
import {
  inspectRequest,
  recordInspectorTabs,
  recordLocation,
} from './inspectorModel'

const props = defineProps<{ controller: TrajectoryController }>()
const emit = defineEmits<{
  'open-subagent': [sessionId: string]
  collapse: []
}>()

const c = props.controller
const record = computed(() => c.selectedRecord.value)
const request = computed(() => {
  const selection = c.selection.value
  if (selection?.kind !== 'request') return undefined
  return inspectRequest({
    selection,
    records: c.records.value.map((candidate) => c.currentRecord(candidate)),
    requestNumbers: c.requestNumbers.value,
    displayNumbers: c.requestDisplayNumbers.value,
  })
})
const tabs = computed(() => {
  if (request.value !== undefined) return request.value.tabs
  if (record.value !== undefined) return recordInspectorTabs(record.value)
  return []
})
const activeTab = computed({
  get: (): string => {
    const current = c.activeTab.value
    return tabs.value.some((tab) => tab.id === current)
      ? current
      : (tabs.value[0]?.id ?? 'overview')
  },
  set: (value: string) => c.activateTab(value as TrajectoryDetailTab),
})
const tabItems = computed(() =>
  tabs.value.map((tab) => ({ id: tab.id, label: tab.label })),
)
</script>

<template>
  <aside
    class="traj-inspector"
    aria-label="事件详情"
    :data-selection="request !== undefined ? 'request' : record?.cell.kind"
  >
    <header class="header">
      <div class="title">
        <span class="heading">详情</span>
        <template v-if="request !== undefined">
          <span class="request-dot" aria-hidden="true" />
          <span class="request-name">Request #{{ request.number ?? '—' }}</span>
          <span class="location">{{ request.location }}</span>
        </template>
        <template v-else-if="record !== undefined">
          <TrajectoryKindTag :kind="record.cell.kind" />
          <span class="location">{{
            record.cell.kind === 'system'
              ? record.cell.text
              : recordLocation(record)
          }}</span>
        </template>
      </div>
      <IconButton label="收起详情" @click="emit('collapse')">
        <PanelRightClose :size="16" />
      </IconButton>
    </header>
    <template v-if="request !== undefined || record !== undefined">
      <Tabs v-model="activeTab" class="tabs" :tabs="tabItems" />
      <div
        class="body"
        role="tabpanel"
        data-trajectory-inspector-body
        :data-tab="activeTab"
      >
        <RequestDetail
          v-if="request !== undefined"
          :controller="controller"
          :inspection="request"
          :tab="activeTab as TrajectoryDetailTab"
        />
        <RecordDetail
          v-else-if="record !== undefined"
          :controller="controller"
          :record="record"
          :tab="activeTab as TrajectoryDetailTab"
          @open-subagent="emit('open-subagent', $event)"
        />
      </div>
    </template>
    <p v-else class="empty">在轨迹中选择一条记录查看详情</p>
  </aside>
</template>

<style scoped>
.traj-inspector {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--bg-layer-1));
  color: rgb(var(--label-primary));
}

.header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 42px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--border-l2);
}

.title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.heading {
  flex: none;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: 500;
}

.request-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgb(var(--label-secondary));
}

.request-name {
  flex: none;
  font: 500 12px / 16px var(--font-mono);
}

.location {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font: 11px / 16px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tabs {
  flex: none;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border-l2);
  overflow-x: auto;
  scrollbar-width: none;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.empty {
  margin: 0;
  padding: var(--space-6) var(--space-4);
  color: rgb(var(--label-tertiary));
  font: var(--font-xs);
  text-align: center;
}
</style>
