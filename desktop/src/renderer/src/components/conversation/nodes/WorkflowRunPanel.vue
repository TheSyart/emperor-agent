<script setup lang="ts">
/**
 * WorkflowRunPanel — dsh workflow run disclosure: run header (32px layer
 * band: name · N 个成员 · status dot), phases (title · count · status
 * counts) and members (dot · label · status). Running / abnormal levels
 * open by default; a running member's label links to its child session.
 *
 * Props: run (WorkflowRunView), expansionKey.
 */
import { computed } from 'vue'
import type {
  WorkflowMemberView,
  WorkflowPhaseView,
  WorkflowRunView,
} from '../../../conversation/types'
import { DsChevronRight } from '../../icons/ds'
import StateDot from '../../ui/StateDot.vue'
import type { StateDotState } from '../../ui/stateDot'
import { useChatContext } from '../chatContext'

type MemberStatus =
  'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

const props = defineProps<{ run: WorkflowRunView; expansionKey: string }>()
const { actions, expansion } = useChatContext()

const STATUS_LABEL: Record<MemberStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

function dot(status: MemberStatus): StateDotState {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'completed':
      return 'ok'
    case 'failed':
      return 'error'
    default:
      return 'warn'
  }
}

const runStatus = computed<MemberStatus>(() => {
  switch (props.run.status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
})

function memberStatus(member: WorkflowMemberView): MemberStatus {
  if (member.outcome !== undefined) return member.outcome
  return props.run.status === 'running' ? 'running' : 'interrupted'
}

const abnormal = (status: MemberStatus): boolean =>
  status === 'failed' || status === 'cancelled' || status === 'interrupted'

function phaseMode(phase: WorkflowPhaseView): 'clean' | 'running' | 'abnormal' {
  const statuses = phase.members.map(memberStatus)
  if (statuses.some(abnormal)) return 'abnormal'
  if (statuses.some((status) => status === 'running')) return 'running'
  return 'clean'
}

const phases = computed(() =>
  props.run.phases.map((phase, index) => ({
    key: `${index}:${phase.title}`,
    title: phase.title === '' ? '未分阶段' : phase.title,
    members: phase.members.map((member) => ({
      ...member,
      status: memberStatus(member),
    })),
    mode: phaseMode(phase),
  })),
)
const totalMembers = computed(() =>
  phases.value.reduce((sum, phase) => sum + phase.members.length, 0),
)
const runMode = computed(() =>
  abnormal(runStatus.value) || phases.value.some((p) => p.mode === 'abnormal')
    ? 'abnormal'
    : runStatus.value === 'running'
      ? 'running'
      : 'clean',
)

function isOpen(key: string, mode: string): boolean {
  return expansion.get(`${props.expansionKey}:${key}`, mode !== 'clean')
}

function toggle(key: string, mode: string): void {
  expansion.set(`${props.expansionKey}:${key}`, !isOpen(key, mode))
}

function phaseSummary(members: { status: MemberStatus }[]): string {
  const counts = new Map<MemberStatus, number>()
  for (const member of members)
    counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const order: MemberStatus[] = [
    'running',
    'failed',
    'cancelled',
    'interrupted',
  ]
  const active = order.filter((status) => (counts.get(status) ?? 0) > 0)
  if (active.length === 0) return `已完成 ${counts.get('completed') ?? 0}`
  return active
    .map((status) => `${STATUS_LABEL[status]} ${counts.get(status) ?? 0}`)
    .join(' · ')
}

const latestLog = computed(() => props.run.logs.at(-1))
</script>

<template>
  <section class="workflow-run" data-workflow-run :data-run-status="run.status">
    <div
      class="run-header"
      role="button"
      tabindex="0"
      :aria-expanded="isOpen('run', runMode)"
      @click="toggle('run', runMode)"
      @keydown.enter.prevent="toggle('run', runMode)"
      @keydown.space.prevent="toggle('run', runMode)"
    >
      <span class="leading" :data-open="isOpen('run', runMode) || undefined">
        <DsChevronRight :size="14" />
      </span>
      <span class="run-title">{{ run.name }}</span>
      <span class="sep" aria-hidden="true" />
      <span class="run-summary">{{ totalMembers }} 个成员</span>
      <span class="status-tail">
        <StateDot :state="dot(runStatus)" />
        <span>{{ STATUS_LABEL[runStatus] }}</span>
      </span>
    </div>
    <div v-if="isOpen('run', runMode)" class="phase-list">
      <span v-if="phases.length === 0" class="run-empty">{{
        run.status === 'running' ? '等待成员启动…' : '没有启动成员'
      }}</span>
      <div v-for="phase in phases" :key="phase.key" class="phase">
        <div
          class="phase-header"
          role="button"
          tabindex="0"
          :aria-expanded="isOpen(phase.key, phase.mode)"
          @click="toggle(phase.key, phase.mode)"
          @keydown.enter.prevent="toggle(phase.key, phase.mode)"
          @keydown.space.prevent="toggle(phase.key, phase.mode)"
        >
          <span
            class="leading"
            :data-open="isOpen(phase.key, phase.mode) || undefined"
          >
            <DsChevronRight :size="14" />
          </span>
          <span class="phase-title">{{ phase.title }}</span>
          <span class="sep" aria-hidden="true" />
          <span class="phase-count">{{ phase.members.length }} 个成员</span>
          <span class="phase-status">{{ phaseSummary(phase.members) }}</span>
        </div>
        <div v-if="isOpen(phase.key, phase.mode)" class="members">
          <component
            :is="member.status === 'running' ? 'button' : 'div'"
            v-for="member in phase.members"
            :key="member.seq"
            :type="member.status === 'running' ? 'button' : undefined"
            class="member"
            :data-member-status="member.status"
            :data-link="member.status === 'running' || undefined"
            :aria-label="
              member.status === 'running'
                ? `打开 ${member.label || '成员'}`
                : undefined
            "
            @click="
              member.status === 'running'
                ? actions.openSubagent(member.childId)
                : undefined
            "
          >
            <span class="dot-slot"
              ><StateDot :state="dot(member.status)"
            /></span>
            <span class="member-label">{{ member.label || '空成员名' }}</span>
            <span class="member-status">{{ STATUS_LABEL[member.status] }}</span>
          </component>
        </div>
      </div>
      <div v-if="run.error" class="run-error">{{ run.error }}</div>
      <div v-else-if="latestLog" class="run-log">{{ latestLog }}</div>
    </div>
  </section>
</template>

<style scoped>
.workflow-run {
  width: 100%;
  min-width: 0;
}

.run-header,
.phase-header {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  min-width: 0;
  height: var(--space-8);
  cursor: pointer;
}

.run-header {
  padding: 0 var(--space-2);
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
}

.run-header:focus-visible,
.phase-header:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.leading {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  color: rgb(var(--label-tertiary));
  transition: transform var(--duration-ds-fast) ease;
}

.leading[data-open] {
  transform: rotate(90deg);
}

.run-title {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-s);
  font-weight: 510;
  line-height: var(--lh-base);
  color: rgb(var(--label-secondary));
}

.sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: rgb(var(--label-tertiary));
}

.run-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.status-tail {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  height: var(--space-5);
  font-size: var(--fs-xxxs);
  font-weight: 510;
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}

.phase-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-1) 0 0 var(--space-4);
}

.phase-title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  color: rgb(var(--label-secondary));
}

.phase-count {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.phase-status {
  flex: none;
  width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: right;
  color: rgb(var(--label-secondary));
}

.members {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  padding-left: var(--space-4);
}

.member {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  min-height: var(--lh-base);
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  text-align: left;
}

.member[data-link] {
  cursor: pointer;
}

.member[data-link] .member-label {
  color: rgb(var(--accent-strong));
  text-decoration: underline;
  text-underline-position: from-font;
}

.member[data-link]:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -1px;
}

.dot-slot {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--lh-base);
}

.member-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
}

.member-status {
  flex: none;
  width: 64px;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: right;
  color: rgb(var(--label-secondary));
}

.run-empty,
.run-log {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-tertiary));
}

.run-log {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-error {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--danger));
  overflow-wrap: anywhere;
}
</style>
