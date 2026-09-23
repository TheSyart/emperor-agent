<script setup lang="ts">
/**
 * SchedulerJobRow — one job of the /scheduler list: a status circle, the
 * name with a small kind glyph (重复 / 一次性, a lock for protected system
 * jobs), the 「星期五（时间：18:00） · 下次运行 3天后」 line, a badge while it
 * runs / queues / last failed, and the ⋯ trigger of the row menu.
 *
 * The name area is a button (opens the job dialog) and the ⋯ button is its
 * sibling, so the two interactive elements never nest.
 *
 * Props: job, now (epoch ms for the relative copy), menuOpen? (⋯ pressed).
 * Emits: open(), menu(anchor) — the ⋯ element the page anchors its menu to.
 */
import { computed } from 'vue'
import {
  CalendarClock,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  LoaderCircle,
  Lock,
  Repeat,
} from 'lucide-vue-next'
import IconButton from '../../ui/IconButton.vue'
import { DsMore } from '../../icons/ds'
import { StatusBadge } from '../../settings/ui'
import {
  schedulerJobLine,
  schedulerRowState,
  type SchedulerRowState,
} from '../../settings/scheduler/schedulerModel'
import type { SchedulerJob } from '../../../types'

const props = withDefaults(
  defineProps<{ job: SchedulerJob; now: number; menuOpen?: boolean }>(),
  { menuOpen: false },
)
const emit = defineEmits<{ open: []; menu: [anchor: HTMLElement] }>()

const GLYPHS = {
  running: LoaderCircle,
  queued: CircleDot,
  error: CircleAlert,
  enabled: Circle,
  paused: CirclePause,
  completed: CircleCheck,
} as const

const STATE_LABELS: Record<SchedulerRowState, string> = {
  running: '运行中',
  queued: '排队中',
  error: '上次运行失败',
  enabled: '已开启',
  paused: '已暂停',
  completed: '已完成',
}

const BADGES: Partial<
  Record<SchedulerRowState, { label: string; tone: 'accent' | 'error' }>
> = {
  running: { label: '运行中', tone: 'accent' },
  queued: { label: '排队中', tone: 'accent' },
  error: { label: '上次失败', tone: 'error' },
}

const state = computed(() => schedulerRowState(props.job))
const glyph = computed(() => GLYPHS[state.value])
const badge = computed(() => BADGES[state.value])
const line = computed(() => schedulerJobLine(props.job, { now: props.now }))
const oneShot = computed(() => props.job.schedule?.kind === 'at')

function onMenu(event: MouseEvent) {
  emit('menu', event.currentTarget as HTMLElement)
}
</script>

<template>
  <li
    class="job-row"
    :data-job-id="job.id"
    :data-state="state"
    :data-menu-open="menuOpen || undefined"
  >
    <button
      type="button"
      class="main"
      :aria-label="`${job.name}，${STATE_LABELS[state]}，${line}`"
      @click="emit('open')"
    >
      <component
        :is="glyph"
        class="glyph"
        :class="{ 'animate-spin': state === 'running' }"
        :size="18"
        :stroke-width="1.75"
        aria-hidden="true"
      />
      <span class="text">
        <span class="title-line">
          <span class="name">{{ job.name }}</span>
          <Lock
            v-if="job.protected"
            class="kind"
            :size="13"
            aria-hidden="true"
          />
          <component
            :is="oneShot ? CalendarClock : Repeat"
            v-else
            class="kind"
            :size="13"
            aria-hidden="true"
          />
        </span>
        <span class="line">{{ line }}</span>
      </span>
    </button>
    <StatusBadge v-if="badge" class="badge" :tone="badge.tone" dot>
      {{ badge.label }}
    </StatusBadge>
    <IconButton
      class="more"
      :label="`「${job.name}」的更多操作`"
      :active="menuOpen"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      data-action="job-menu"
      @click="onMenu"
    >
      <DsMore :size="16" />
    </IconButton>
  </li>
</template>

<style scoped>
.job-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding-right: var(--space-2);
  border-radius: var(--radius-row);
}

.job-row:hover,
.job-row[data-menu-open] {
  background: var(--interactive-bg-hover);
}

.main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2-5) var(--space-3);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.main:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -2px;
}

.glyph {
  flex: none;
  color: rgb(var(--label-secondary));
}

.job-row[data-state='running'] .glyph,
.job-row[data-state='queued'] .glyph {
  color: rgb(var(--accent-fill));
}

.job-row[data-state='error'] .glyph {
  color: rgb(var(--state-error));
}

.job-row[data-state='paused'] .glyph {
  color: rgb(var(--label-tertiary));
}

.job-row[data-state='completed'] .glyph {
  color: rgb(var(--state-ok));
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title-line {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.name {
  overflow: hidden;
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.line {
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge,
.more {
  flex: none;
}
</style>
