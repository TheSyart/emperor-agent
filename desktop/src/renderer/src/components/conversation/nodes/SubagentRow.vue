<script setup lang="ts">
/**
 * SubagentRow — one subagent on one line (UI-S14): portrait (Claude Code
 * and Codex: their logo), name, where it runs, its status with the time
 * (a neutral spinner while it runs; failures in the error colour, 等待回答
 * and 结果待确认 in the attention colour) and ↗ on hover. The whole row is
 * the link that opens the child (the name is the anchor, stretched over
 * the row), so 任务详情 of a Claude Code / Codex run can sit beside it as
 * a hover action. After the run ends a single row adds one muted line:
 * the report's opening, or why it failed; in a group (and the status bar)
 * that line is the row's tooltip, as in the approved design.
 *
 * Props: row (SubagentRowView), href (null: nothing to open yet),
 * variant ('single' in the flow, 'grouped' in a group or the status bar),
 * details (offer 任务详情). Emits: open(event), details().
 */
import { computed } from 'vue'
import Avatar from '../../ui/Avatar.vue'
import LinkButton from '../../ui/LinkButton.vue'
import Spinner from '../../ui/Spinner.vue'
import { useSubagentNow } from '../subagentClock'
import { subagentStatusText, type SubagentRowView } from '../subagentRows'

const props = withDefaults(
  defineProps<{
    row: SubagentRowView
    href?: string | null
    variant?: 'single' | 'grouped'
    details?: boolean
  }>(),
  { href: null, variant: 'grouped', details: false },
)
const emit = defineEmits<{ open: [event: MouseEvent]; details: [] }>()

const now = useSubagentNow(() => props.row.active)
const status = computed(() => subagentStatusText(props.row, now.value))
const faceSize = computed(() => (props.variant === 'single' ? 24 : 20))
const logoSize = computed(() => (props.variant === 'single' ? 20 : 16))
</script>

<template>
  <div
    class="subagent"
    data-subagent-row
    :data-state="row.state"
    :data-tone="row.tone"
    :data-variant="variant"
    :data-agent-id="row.agentId"
    :title="variant === 'grouped' && row.summary ? row.summary : undefined"
  >
    <div class="line">
      <span class="lead">
        <a
          v-if="href"
          class="entry"
          data-agent-entry
          :href="href"
          @click="emit('open', $event)"
        >
          <span class="face" :data-size="faceSize">
            <Avatar
              v-if="row.face.kind === 'sprite'"
              kind="sprite"
              :id="row.face.id"
              :size="faceSize"
            />
            <Avatar
              v-else
              kind="logo"
              :icon-id="row.face.backend"
              :label="row.source"
              :size="logoSize"
              :data-agent-logo="row.face.backend"
            />
          </span>
          <span class="title">{{ row.title }}</span>
          <small class="source">{{ row.source }}</small>
        </a>
        <span v-else class="entry">
          <span class="face" :data-size="faceSize">
            <Avatar
              v-if="row.face.kind === 'sprite'"
              kind="sprite"
              :id="row.face.id || row.key"
              :size="faceSize"
            />
            <Avatar
              v-else
              kind="logo"
              :icon-id="row.face.backend"
              :label="row.source"
              :size="logoSize"
              :data-agent-logo="row.face.backend"
            />
          </span>
          <span class="title">{{ row.title }}</span>
          <small class="source">{{ row.source }}</small>
        </span>
        <LinkButton
          v-if="details && row.run"
          class="details"
          data-agent-details
          @click="emit('details')"
          >任务详情</LinkButton
        >
      </span>
      <span class="status" data-agent-status :data-tone="row.tone"
        ><Spinner
          v-if="row.tone === 'running'"
          size="sm"
          class="spin"
          :label="row.label"
        />{{ status }}</span
      >
      <span v-if="href" class="go" aria-hidden="true">↗</span>
    </div>
    <p
      v-if="variant === 'single' && row.summary"
      class="summary"
      data-agent-summary
    >
      {{ row.summary }}
    </p>
  </div>
</template>

<style scoped>
.subagent {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-row);
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.subagent:hover {
  background: var(--surface-hover);
}

/* In the flow the row bleeds into the gutter so its face lines up. */
.subagent[data-variant='single'] {
  margin-inline: calc(-1 * var(--space-2));
}

.line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.lead {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.entry {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-decoration: none;
}

[data-variant='single'] .entry {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

/* The name's link covers the whole row (summary included). */
a.entry::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

a.entry:focus-visible {
  outline: none;
}

a.entry:focus-visible::after {
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.face {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.face[data-size='24'] {
  width: 24px;
  height: 24px;
}

.title {
  min-width: 0;
  overflow: hidden;
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source {
  flex: none;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

/* 任务详情 sits above the stretched link; it shows with the hover. */
.details {
  position: relative;
  z-index: var(--z-raised);
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}

.subagent:hover .details,
.subagent:focus-within .details {
  opacity: 1;
}

.status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.status[data-tone='error'] {
  color: rgb(var(--error));
}

.status[data-tone='attention'] {
  color: rgb(var(--attention));
}

.status[data-tone='muted'] {
  color: rgb(var(--text-4));
}

.go {
  flex: none;
  width: var(--space-3-5);
  color: rgb(var(--text-4));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: center;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}

.subagent:hover .go,
.subagent:focus-within .go {
  opacity: 1;
}

.summary {
  margin: 0;
  padding-left: calc(24px + var(--space-2-5));
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
