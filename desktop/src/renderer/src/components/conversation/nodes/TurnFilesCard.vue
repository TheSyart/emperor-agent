<script setup lang="ts">
/**
 * TurnFilesCard — 「已编辑 N 个文件 +A −D」 at the end of a turn (plan 7.6):
 * one row per file (folder dim, name bright, lines added and removed), the
 * first five until 展开. 审核 opens the 审查 pane's 本轮改动 mode (a row
 * opens it on that file) and 撤销 asks before undoing; both need the
 * turn's snapshots (a Git project). An undone turn says so and lists what
 * was skipped. A turn whose snapshot failed says it was not recorded.
 *
 * Coexists with ChangesPill: this card is what one turn changed, the pill
 * is how far the workspace is from HEAD now.
 *
 * Props: node (TurnFilesChatNode).
 */
import { FileDiff } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { TurnFilesChatNode } from '../../../conversation/types'
import Button from '../../ui/Button.vue'
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
        <FileDiff :size="14" class="icon" aria-hidden="true" />
        <span class="headline">已编辑 {{ data.totals.files }} 个文件</span>
        <span class="add">+{{ data.totals.additions }}</span>
        <span class="del">−{{ data.totals.deletions }}</span>
        <span class="actions">
          <span v-if="data.reverted" class="reverted">
            {{ revertSummary(data.reverted) }}
          </span>
          <template v-else-if="data.reviewable">
            <Button size="sm" data-action="review" @click="review()">
              审核
            </Button>
            <Button
              size="sm"
              data-action="undo"
              :disabled="!canUndo"
              @click="confirming = true"
            >
              撤销
            </Button>
          </template>
        </span>
      </header>
      <ul class="files">
        <li v-for="row in rows" :key="row.file.path">
          <button
            type="button"
            class="file"
            :disabled="!data.reviewable"
            :title="row.file.path"
            @click="review(row.file.path)"
          >
            <span class="path">
              <span class="dir">{{ row.dir }}</span>
              <span class="name">{{ row.name }}</span>
            </span>
            <span v-if="row.tag" class="tag">{{ row.tag }}</span>
            <span v-if="row.outcome" class="outcome">{{ row.outcome }}</span>
            <span v-if="'note' in row.counts" class="note">
              {{ row.counts.note }}
            </span>
            <span v-else class="counts">
              <span class="add">{{ row.counts.additions }}</span>
              <span class="del">{{ row.counts.deletions }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div class="foot">
        <button
          v-if="hidden > 0"
          type="button"
          class="more"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : `展开其余 ${hidden} 个` }}
        </button>
        <span class="caption">{{ turnFilesCaption(data) }}</span>
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
  padding: var(--space-2-5) var(--space-3);
  color: rgb(var(--label-secondary));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
}

.icon {
  flex: none;
  color: rgb(var(--label-secondary));
}

.headline {
  font-weight: 600;
}

.add {
  color: rgb(var(--ok));
  font-variant-numeric: tabular-nums;
}

.del {
  color: rgb(var(--danger));
  font-variant-numeric: tabular-nums;
}

.actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.reverted {
  padding-right: var(--space-1);
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
}

.files {
  margin: 0;
  padding: 0 0 var(--space-1);
  list-style: none;
}

.file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-3);
  border: 0;
  background: transparent;
  color: rgb(var(--label-primary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-align: start;
  cursor: pointer;
}

.file:disabled {
  cursor: default;
}

.file:not(:disabled):hover {
  background: rgb(var(--fg) / var(--hover-bg-a));
}

.path {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
}

.dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(var(--label-tertiary));
}

.name {
  flex: none;
}

.tag,
.note,
.outcome {
  flex: none;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
}

.counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1);
}

.foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3) var(--space-2);
  border-top: 1px solid var(--border-l2);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.more {
  padding: 0;
  border: 0;
  background: transparent;
  color: rgb(var(--accent-strong));
  font: inherit;
  cursor: pointer;
}

.caption {
  margin-left: auto;
  color: rgb(var(--label-tertiary));
}
</style>
