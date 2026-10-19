<script setup lang="ts">
/**
 * TurnFilesCard — 「已编辑 N 个文件 +A −D」 at the end of a turn (plan 7.6):
 * one row per file (folder dim, name bright, lines added and removed), the
 * first three until expanded. 查看变更 opens the 审查 pane's 本轮改动 mode (file rows open current content in Files) and 撤销 asks before undoing; both need the
 * turn's snapshots (a Git project). An undone turn says so and lists what
 * was skipped. A turn whose snapshot failed says it was not recorded.
 *
 * Coexists with ChangesPill: this card is what one turn changed, the pill
 * is how far the workspace is from HEAD now.
 *
 * Props: node (TurnFilesChatNode).
 */
import Badge from '../../ui/Badge.vue'
import { ChevronDown, ChevronUp, FileDiff, Info, Undo2 } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { TurnFilesChatNode } from '../../../conversation/types'
import Button from '../../ui/Button.vue'
import DocumentIcon from '../../ui/DocumentIcon.vue'
import Tooltip from '../../ui/Tooltip.vue'
import { requestWorkspace } from '../../workspace/workspaceState'
import { useChatContext, useExpansion } from '../chatContext'
import TurnRevertDialog from './TurnRevertDialog.vue'
import {
  COLLAPSED_FILE_ROWS,
  fileCounts,
  fileStatusTag,
  revertSkipLabel,
  revertSummary,
  splitFilePath,
  turnFilesCaption,
  turnFilesSkippedText,
} from './turnFilesModel'

const props = defineProps<{ node: TurnFilesChatNode }>()
const { sessionId } = useChatContext()
const data = computed(() => props.node.data)
const expanded = useExpansion(() => `${props.node.key}:files`)
const confirming = ref(false)

const rows = computed(() => {
  const skipped = new Map(
    (data.value.reverted?.skipped ?? []).map((item) => [
      item.path,
      revertSkipLabel(item.reason),
    ]),
  )
  const reverted = new Set(data.value.reverted?.reverted ?? [])
  const files = expanded.value
    ? data.value.files
    : data.value.files.slice(0, COLLAPSED_FILE_ROWS)
  return files.map((file) => ({
    file,
    ...splitFilePath(file.path),
    tag: fileStatusTag(file),
    counts: fileCounts(file),
    outcome:
      skipped.get(file.path) ?? (reverted.has(file.path) ? '已恢复' : null),
  }))
})
const hidden = computed(() => data.value.files.length - COLLAPSED_FILE_ROWS)
const canUndo = computed(
  () => data.value.reviewable && data.value.reverted === undefined,
)

function review(path?: string): void {
  if (!data.value.reviewable) return
  requestWorkspace({
    pane: 'review',
    turn: {
      sessionId: sessionId(),
      turn: data.value.turn,
      files: data.value.files,
      ...(path === undefined ? {} : { path }),
    },
  })
}

function openFile(path: string): void {
  const owner = sessionId()
  requestWorkspace({
    pane: 'files',
    file: {
      owner,
      target: { source: 'turn', sessionId: owner, turn: data.value.turn, path },
    },
  })
}
</script>

<template>
  <section
    class="turn-files"
    :data-turn-files="data.turn"
    :data-state="
      data.status === 'skipped'
        ? 'skipped'
        : data.reverted
          ? 'reverted'
          : 'recorded'
    "
    aria-label="本轮改动"
  >
    <p v-if="data.status === 'skipped'" class="skipped">
      <FileDiff :size="14" aria-hidden="true" />
      {{ turnFilesSkippedText(data.skipReason) }}
    </p>
    <template v-else>
      <header class="head">
        <div class="summary">
          <span class="icon-badge"
            ><FileDiff :size="20" aria-hidden="true"
          /></span>
          <div class="summary-text">
            <div class="summary-title">
              <span class="headline"
                >已编辑 {{ data.totals.files }} 个文件</span
              >
              <Tooltip :label="turnFilesCaption(data)">
                <span
                  class="scope-info"
                  role="img"
                  tabindex="0"
                  :aria-label="turnFilesCaption(data)"
                >
                  <Info :size="14" aria-hidden="true" />
                </span>
              </Tooltip>
            </div>
            <div
              class="totals"
              :aria-label="`新增 ${data.totals.additions} 行，删除 ${data.totals.deletions} 行`"
            >
              <span class="add">+{{ data.totals.additions }}</span>
              <span class="del">−{{ data.totals.deletions }}</span>
            </div>
          </div>
        </div>
        <div v-if="data.reviewable || data.reverted" class="actions">
          <span v-if="data.reverted" class="reverted">
            {{ revertSummary(data.reverted) }}
          </span>
          <template v-else-if="data.reviewable">
            <Button
              size="sm"
              data-action="undo"
              :disabled="!canUndo"
              @click="confirming = true"
            >
              <template #icon><Undo2 :size="14" aria-hidden="true" /></template>
              撤销
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-action="review"
              @click="review()"
            >
              查看变更
            </Button>
          </template>
        </div>
      </header>
      <ul class="files">
        <li v-for="row in rows" :key="row.file.path">
          <button
            type="button"
            class="file"
            :title="row.file.path"
            @click="openFile(row.file.path)"
          >
            <DocumentIcon :path="row.file.path" :size="18" />
            <span class="file-main">
              <span class="path"
                ><span class="dir">{{ row.dir }}</span
                ><span class="name">{{ row.name }}</span></span
              >
              <span
                v-if="row.tag || row.outcome || 'note' in row.counts"
                class="file-meta"
              >
                <Badge v-if="row.tag">{{ row.tag }}</Badge>
                <span v-if="row.outcome" class="outcome">{{
                  row.outcome
                }}</span>
                <span v-if="'note' in row.counts" class="note">{{
                  row.counts.note
                }}</span>
              </span>
            </span>
            <span v-if="!('note' in row.counts)" class="counts">
              <span class="add">{{ row.counts.additions }}</span>
              <span class="del">{{ row.counts.deletions }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div v-if="hidden > 0 || data.truncated" class="foot">
        <button
          v-if="hidden > 0"
          type="button"
          class="more"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起文件列表' : `再显示 ${hidden} 个文件` }}
          <component
            :is="expanded ? ChevronUp : ChevronDown"
            :size="14"
            aria-hidden="true"
          />
        </button>
        <span v-if="data.truncated" class="limit">仅显示前 200 个文件</span>
      </div>
    </template>
    <TurnRevertDialog
      v-if="canUndo"
      v-model:open="confirming"
      :session-id="sessionId()"
      :turn="data.turn"
      :files="data.files"
      :concurrent="data.concurrent"
    />
  </section>
</template>

<style scoped>
.turn-files {
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-elevated));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.skipped {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: rgb(var(--label-secondary));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3-5) var(--space-4);
}

.summary {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.icon-badge {
  display: grid;
  place-items: center;
  flex: none;
  width: calc(var(--space-8) + var(--space-2));
  height: calc(var(--space-8) + var(--space-2));
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg));
  color: rgb(var(--label-secondary));
}

.summary-text {
  min-width: 0;
}

.summary-title {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.headline {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.scope-info {
  display: inline-flex;
  border-radius: var(--radius-xs);
  color: rgb(var(--label-tertiary));
  cursor: help;
}

.scope-info:focus-visible,
.more:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 3px;
}

.totals {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-0-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.add,
.del {
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--ok));
}

.del {
  color: rgb(var(--danger));
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.reverted {
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
}

.files {
  margin: 0;
  padding: var(--space-1) 0;
  border-top: 1px solid var(--border-l2);
  background: rgb(var(--bg) / 0.3);
  list-style: none;
}

.file {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  width: 100%;
  min-height: calc(calc(var(--space-8) + var(--space-2)) + var(--space-1));
  padding: var(--space-2-5) var(--space-4);
  border: 0;
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-s);
  text-align: start;
  cursor: pointer;
}

.file:hover {
  background: var(--interactive-bg-hover);
}

.file:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: -3px;
}

.file-main {
  flex: 1;
  min-width: 0;
}

.path {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
}

.dir {
  color: rgb(var(--label-tertiary));
}

.name {
  color: rgb(var(--label-primary));
}

.file-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-0-5);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  overflow-wrap: anywhere;
}

.counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1-5);
  align-self: center;
  font-size: var(--fs-xs);
}

.foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  border-top: 1px solid var(--border-l2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.more {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-2-5) var(--space-4);
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: rgb(var(--label-secondary));
  font: inherit;
  cursor: pointer;
}

.more:hover {
  color: rgb(var(--label-primary));
  background: var(--interactive-bg-hover);
}

.limit {
  padding: var(--space-2) var(--space-4);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
}

@container (max-width: 420px) {
  .head {
    flex-wrap: wrap;
  }

  .actions {
    margin-inline-start: calc(
      calc(var(--space-8) + var(--space-2)) + var(--space-3)
    );
  }
}
</style>
