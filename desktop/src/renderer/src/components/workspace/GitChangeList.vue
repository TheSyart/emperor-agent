<script setup lang="ts">
/**
 * GitChangeList — the 审查 pane's change list (UI-S06): 已暂存 and 未暂存,
 * a group without files not drawn. One 32px row per file: its change letter,
 * name and folder, and +A −D (success / error colours, tabular figures);
 * hovering or focusing the row swaps the counts for 暂存 · 丢弃 (取消暂存 in
 * 已暂存), and the group label for 全部暂存 / 全部取消暂存. Clicking a file
 * shows its diff under the row; clicking again hides it.
 *
 * Reads the review GitReviewPane provides (useGitReview).
 */
import { Minus, Plus, Undo2 } from 'lucide-vue-next'
import DiffBlock from '../ui/DiffBlock.vue'
import IconButton from '../ui/IconButton.vue'
import { splitFilePath } from '../conversation/nodes/turnFilesModel'
import type { ReviewEntry, ReviewGroup } from './gitReviewModel'
import { injectGitReview } from './useGitReview'

const { groups, diff, writesDisabled, toggleDiff, stage, unstage, discard } =
  injectGitReview()

/** +A −D, each side only when non-zero; binaries have none. */
function counts(entry: ReviewEntry): { add: string; del: string } | null {
  const { additions = 0, deletions = 0, binary } = entry.file
  if (binary || (!additions && !deletions)) return null
  return {
    add: additions ? `+${additions}` : '',
    del: deletions ? `−${deletions}` : '',
  }
}

function paths(group: ReviewGroup): string[] {
  return group.entries.map((entry) => entry.file.path)
}

function groupAction(group: ReviewGroup): string {
  return group.id === 'staged' ? '全部取消暂存' : '全部暂存'
}

function moveGroup(group: ReviewGroup): void {
  void (group.id === 'staged' ? unstage(paths(group)) : stage(paths(group)))
}
</script>

<template>
  <div class="change-list">
    <section
      v-for="group in groups"
      :key="group.id"
      class="change-group"
      :data-group="group.id"
      :aria-label="group.label"
    >
      <header class="group-head">
        <h3 class="group-label">{{ group.label }}</h3>
        <span class="group-count">{{ group.entries.length }}</span>
        <IconButton
          class="group-action"
          size="xs"
          :label="groupAction(group)"
          :disabled="writesDisabled"
          @click="moveGroup(group)"
        >
          <Minus v-if="group.id === 'staged'" :size="12" />
          <Plus v-else :size="12" />
        </IconButton>
      </header>
      <template v-for="entry in group.entries" :key="entry.key">
        <div
          class="change-row"
          :data-path="entry.file.path"
          :data-open="diff?.key === entry.key || undefined"
        >
          <button
            type="button"
            class="change-main"
            :title="entry.file.path"
            :aria-expanded="diff?.key === entry.key"
            @click="toggleDiff(entry)"
          >
            <span
              class="change-status"
              :data-tone="entry.status.tone"
              :title="entry.status.label"
              >{{ entry.status.letter }}</span
            >
            <span class="change-name">{{
              splitFilePath(entry.file.path).name
            }}</span>
            <span class="change-dir">{{
              splitFilePath(entry.file.path).dir
            }}</span>
          </button>
          <span v-if="counts(entry)" class="change-counts">
            <span v-if="counts(entry)!.add" class="add">{{
              counts(entry)!.add
            }}</span>
            <span v-if="counts(entry)!.del" class="del">{{
              counts(entry)!.del
            }}</span>
          </span>
          <span class="change-actions">
            <template v-if="entry.area === 'staged'">
              <IconButton
                :label="`取消暂存 ${entry.file.path}`"
                tooltip="取消暂存"
                :disabled="writesDisabled"
                @click="unstage([entry.file.path])"
              >
                <Minus :size="14" />
              </IconButton>
            </template>
            <template v-else>
              <IconButton
                :label="`丢弃 ${entry.file.path}`"
                tooltip="丢弃"
                :disabled="writesDisabled"
                @click="discard(entry.file.path)"
              >
                <Undo2 :size="14" />
              </IconButton>
              <IconButton
                :label="`暂存 ${entry.file.path}`"
                tooltip="暂存"
                :disabled="writesDisabled"
                @click="stage([entry.file.path])"
              >
                <Plus :size="14" />
              </IconButton>
            </template>
          </span>
        </div>
        <div v-if="diff?.key === entry.key" class="change-diff">
          <p v-if="diff.loading" class="diff-note">正在读取差异…</p>
          <p v-else-if="diff.note" class="diff-note">{{ diff.note }}</p>
          <DiffBlock v-else :diffs="diff.hunks" :max-lines="240" />
          <p v-if="diff.truncated" class="diff-note">
            差异过长，只显示开头部分。
          </p>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* Whitespace, not rules, between the groups. */
.change-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--space-7);
  padding: 0 var(--space-1) 0 var(--space-2);
}

.group-label {
  margin: 0;
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-caption) var(--font-sans);
}

.group-count {
  color: rgb(var(--text-4));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.group-action {
  margin-left: auto;
  visibility: hidden;
}

.group-head:hover .group-action,
.group-head:focus-within .group-action {
  visibility: visible;
}

.change-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  box-sizing: border-box;
  height: var(--row-h);
  padding: 0 var(--space-1) 0 0;
  border-radius: var(--r-sm);
}

.change-row:hover {
  background: var(--surface-hover);
}

.change-row[data-open] {
  background: rgb(var(--surface-selected));
}

.change-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  height: 100%;
  padding: 0 var(--space-1) 0 var(--space-2);
  border: none;
  border-radius: var(--r-sm);
  outline: none;
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  text-align: left;
  cursor: pointer;
}

.change-main:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.55);
}

.change-status {
  flex: none;
  width: var(--icon-md);
  color: rgb(var(--text-3));
  font: var(--weight-medium) var(--type-caption) var(--font-mono);
  text-align: center;
}

.change-status[data-tone='ok'] {
  color: rgb(var(--ok));
}

.change-status[data-tone='error'] {
  color: rgb(var(--error));
}

.change-name {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-dir {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1-5);
  padding-right: var(--space-1-5);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--ok));
}

.del {
  color: rgb(var(--error));
}

/* Hover (or keyboard focus) swaps the counts for the row's actions. */
.change-actions {
  display: none;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.change-row:hover .change-actions,
.change-row:focus-within .change-actions {
  display: inline-flex;
}

.change-row:hover .change-counts,
.change-row:focus-within .change-counts {
  display: none;
}

.change-diff {
  margin: var(--space-1) 0 var(--space-2) var(--space-6);
}

.diff-note {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
}
</style>
