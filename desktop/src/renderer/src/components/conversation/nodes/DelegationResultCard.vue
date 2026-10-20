<script setup lang="ts">
/**
 * DelegationResultCard — 「Codex 改了 6 个文件 +120 −8 · 查看差异 · 应用到项目
 * · 丢弃」 (AGT-06): what a subagent changed in its isolated workspace, in the
 * same shape as the 「已编辑 N 个文件」 card (file rows, type icons, +A −D).
 *
 * 应用到项目 is a three-way merge into the current workspace; a conflict
 * applies nothing and lists the files. An applied result can be undone
 * (asks first). 丢弃 removes the result. A result nobody handled for 14
 * days offers 清理. With 高级 › 验证后再应用 on, the primary action opens the
 * receipt / check / preview chain in the task details instead.
 *
 * Props: node (DelegationResultChatNode).
 */
import { computed, defineAsyncComponent, ref } from 'vue'
import {
  ChevronDown,
  ChevronUp,
  Info,
  TriangleAlert,
  Undo2,
} from 'lucide-vue-next'
import {
  agentSourceLabel,
  resultNeedsCleanup,
} from '@emperor/core/runtime-contract'
import type { DelegationResultChatNode } from '../../../conversation/types'
import {
  applyDelegationResult,
  discardDelegationResult,
  undoDelegationResult,
} from '../../../api/delegations'
import Avatar from '../../ui/Avatar.vue'
import Badge from '../../ui/Badge.vue'
import Button from '../../ui/Button.vue'
import DocumentIcon from '../../ui/DocumentIcon.vue'
import Tooltip from '../../ui/Tooltip.vue'
import { confirm } from '../../ui/confirm'
import { useChatContext, useExpansion } from '../chatContext'
import {
  COLLAPSED_FILE_ROWS,
  fileCounts,
  fileStatusTag,
  revertSkipLabel,
  revertSummary,
  splitFilePath,
} from './turnFilesModel'

const DelegationDiffDialog = defineAsyncComponent(
  () => import('./DelegationDiffDialog.vue'),
)
const ExternalAgentDetails = defineAsyncComponent(
  () => import('../environment/ExternalAgentDetails.vue'),
)

const props = defineProps<{ node: DelegationResultChatNode }>()
const chat = useChatContext()
/** Delegation operations name the conversation that owns the subagent. */
const owner = () => chat.rootSessionId?.() ?? chat.sessionId()
const data = computed(() => props.node.data)
const expanded = useExpansion(() => `${props.node.key}:files`)
const busy = ref<'' | 'apply' | 'discard' | 'undo'>('')
const error = ref('')
const diffPath = ref<string | null>(null)
const details = ref(false)

const source = computed(() => agentSourceLabel(data.value.backend))
const pending = computed(
  () => data.value.state === 'ready' || data.value.state === 'conflicted',
)
const conflicts = computed(() => new Set(data.value.conflicts))
const rows = computed(() => {
  const skipped = new Map(
    (data.value.reverted?.skipped ?? []).map((item) => [
      item.path,
      revertSkipLabel(item.reason),
    ]),
  )
  // Conflicting files first: they are what the user has to look at.
  const files = [...data.value.files].sort(
    (a, b) =>
      Number(conflicts.value.has(b.path)) - Number(conflicts.value.has(a.path)),
  )
  return (expanded.value ? files : files.slice(0, COLLAPSED_FILE_ROWS)).map(
    (file) => ({
      file,
      ...splitFilePath(file.path),
      tag: fileStatusTag(file),
      counts: fileCounts(file),
      conflict: conflicts.value.has(file.path),
      outcome: skipped.get(file.path) ?? null,
    }),
  )
})
const hidden = computed(() => data.value.files.length - COLLAPSED_FILE_ROWS)
const caption = computed(() =>
  pending.value
    ? `${source.value} 在独立的工作区里改了这些文件，还没有进入项目；应用时会与项目里现在的改动合并`
    : data.value.state === 'discarded'
      ? '成果已丢弃，项目没有变化'
      : '应用前后的项目对比',
)
const staleDays = computed(() =>
  resultNeedsCleanup(data.value)
    ? Math.floor((Date.now() - data.value.at) / 86_400_000)
    : 0,
)

async function run(
  kind: 'apply' | 'discard' | 'undo',
  task: () => Promise<unknown>,
): Promise<void> {
  if (busy.value) return
  busy.value = kind
  error.value = ''
  try {
    await task()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = ''
  }
}
const resultRef = () => ({ runId: data.value.runId, sessionId: owner() })
function apply(): Promise<void> {
  return run('apply', () => applyDelegationResult(resultRef()))
}
async function discard(cleanup = false): Promise<void> {
  const confirmed = await confirm({
    title: cleanup ? '清理这个成果？' : '丢弃这个成果？',
    body: `${source.value} 的 ${data.value.totals.files} 个文件改动会被删除，项目里的文件不受影响。`,
    confirmLabel: cleanup ? '清理' : '丢弃',
    tone: 'danger',
  })
  if (confirmed)
    await run('discard', () => discardDelegationResult(resultRef()))
}
async function undo(): Promise<void> {
  const confirmed = await confirm({
    title: '撤销应用的改动？',
    body: '这些文件会恢复到应用之前；应用后又改过的文件会保留并跳过。',
    confirmLabel: '撤销',
  })
  if (confirmed) await run('undo', () => undoDelegationResult(resultRef()))
}
</script>

<template>
  <section
    class="result"
    data-delegation-result
    :data-state="data.state"
    :aria-label="`${source} 的成果`"
  >
    <header class="head">
      <div class="summary">
        <span class="icon-badge">
          <Avatar
            kind="logo"
            :icon-id="data.backend"
            :label="source"
            :size="20"
          />
        </span>
        <div class="summary-text">
          <div class="summary-title">
            <span class="headline"
              >{{ source }} 改了 {{ data.totals.files }} 个文件</span
            >
            <Tooltip :label="caption">
              <span
                class="scope-info"
                role="img"
                tabindex="0"
                :aria-label="caption"
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
            <span v-if="data.title" class="task">{{ data.title }}</span>
          </div>
        </div>
      </div>
      <div class="actions">
        <template v-if="pending">
          <Button
            size="sm"
            data-action="discard"
            :disabled="busy !== ''"
            @click="discard()"
            >丢弃</Button
          >
          <Button
            size="sm"
            variant="secondary"
            data-action="diff"
            @click="diffPath = ''"
            >查看差异</Button
          >
          <Button
            v-if="data.verifyFirst"
            size="sm"
            variant="primary"
            data-action="verify"
            @click="details = true"
            >验证后再应用</Button
          >
          <Button
            v-else
            size="sm"
            variant="primary"
            data-action="apply"
            :loading="busy === 'apply'"
            :disabled="busy !== '' && busy !== 'apply'"
            @click="apply"
            >{{
              data.state === 'conflicted' ? '再次应用' : '应用到项目'
            }}</Button
          >
        </template>
        <template v-else-if="data.state === 'applied'">
          <span class="status">已应用到项目</span>
          <Button
            v-if="data.undoable"
            size="sm"
            data-action="undo"
            :loading="busy === 'undo'"
            @click="undo"
          >
            <template #icon><Undo2 :size="14" aria-hidden="true" /></template>
            撤销
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-action="diff"
            @click="diffPath = ''"
            >查看差异</Button
          >
        </template>
        <template v-else-if="data.state === 'reverted'">
          <span class="status">{{
            data.reverted ? revertSummary(data.reverted) : '已撤销'
          }}</span>
          <Button
            size="sm"
            variant="secondary"
            data-action="diff"
            @click="diffPath = ''"
            >查看差异</Button
          >
        </template>
        <span v-else class="status">已丢弃</span>
      </div>
    </header>
    <p
      v-if="data.state === 'conflicted'"
      class="note warn"
      data-result-conflict
      role="status"
    >
      <TriangleAlert :size="14" aria-hidden="true" />
      {{ data.conflicts.length }}
      个文件与项目里的改动冲突，没有应用任何文件。改好这些文件后可以再次应用。
    </p>
    <p v-if="error" class="note error" role="alert">{{ error }}</p>
    <ul class="files" :data-muted="data.state === 'discarded' || undefined">
      <li v-for="row in rows" :key="row.file.path">
        <button
          type="button"
          class="file"
          :title="row.file.path"
          :disabled="data.state === 'discarded'"
          @click="diffPath = row.file.path"
        >
          <DocumentIcon :path="row.file.path" :size="18" />
          <span class="file-main">
            <span class="path"
              ><span class="dir">{{ row.dir }}</span
              ><span class="name">{{ row.name }}</span></span
            >
            <span
              v-if="
                row.tag || row.conflict || row.outcome || 'note' in row.counts
              "
              class="file-meta"
            >
              <Badge v-if="row.conflict" tone="warn">冲突</Badge>
              <Badge v-if="row.tag">{{ row.tag }}</Badge>
              <span v-if="row.outcome" class="outcome">{{ row.outcome }}</span>
              <span v-if="'note' in row.counts" class="count-note">{{
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
    <div v-if="staleDays > 0 && pending" class="cleanup" data-result-cleanup>
      <span>这个成果已保留 {{ staleDays }} 天，还没有处理。</span>
      <Button size="sm" :disabled="busy !== ''" @click="discard(true)"
        >清理</Button
      >
    </div>
    <DelegationDiffDialog
      v-if="diffPath !== null"
      :run-id="data.runId"
      :session-id="owner()"
      :source="source"
      :files="data.files"
      :path="diffPath"
      @close="diffPath = null"
    />
    <ExternalAgentDetails
      v-if="details"
      :run-id="data.runId"
      :delegation-id="data.delegationId"
      :session-id="owner()"
      @close="details = false"
    />
  </section>
</template>

<style scoped>
.result {
  container-type: inline-size;
  overflow: hidden;
  border-radius: var(--r-md);
  background: rgb(var(--surface-base));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  color: rgb(var(--text-1));
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
  border-radius: var(--r-sm);
  background: rgb(var(--surface-canvas));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
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
  font-weight: var(--weight-semibold);
  overflow-wrap: anywhere;
}

.scope-info {
  display: inline-flex;
  border-radius: var(--r-xs);
  color: rgb(var(--text-3));
  cursor: help;
}

.scope-info:focus-visible,
.more:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 3px;
}

.totals {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin-top: var(--space-0-5);
  font: var(--type-caption) var(--font-sans);
}

.task {
  overflow: hidden;
  min-width: 0;
  color: rgb(var(--text-3));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add,
.del {
  font-variant-numeric: tabular-nums;
}

.add {
  color: rgb(var(--ok));
}

.del {
  color: rgb(var(--error));
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.status {
  color: rgb(var(--text-2));
  font: var(--type-caption) var(--font-sans);
}

.note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1-5);
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  font: var(--type-caption) var(--font-sans);
}

.note svg {
  flex: none;
  margin-top: var(--space-0-5);
}

.note.warn {
  color: rgb(var(--warn));
}

.note.error {
  color: rgb(var(--error));
  overflow-wrap: anywhere;
}

.files {
  margin: 0;
  padding: var(--space-1) 0;
  box-shadow: inset 0 0.5px 0 var(--stroke-1);
  background: rgb(var(--surface-canvas) / 0.3);
  list-style: none;
}

.files[data-muted] {
  opacity: 0.6;
}

.file {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  width: 100%;
  /* The turn files card's row rhythm (44px with its 10px padding). */
  min-height: calc(var(--row-h) + var(--space-3));
  padding: var(--space-2-5) var(--space-4);
  border: 0;
  background: transparent;
  color: rgb(var(--text-1));
  font: var(--type-caption) var(--font-sans);
  text-align: start;
  cursor: pointer;
}

.file:disabled {
  cursor: default;
}

.file:not(:disabled):hover {
  background: var(--surface-hover);
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
  overflow-wrap: anywhere;
}

.dir {
  color: rgb(var(--text-3));
}

.name {
  color: rgb(var(--text-1));
}

.file-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-0-5);
  color: rgb(var(--text-2));
}

.counts {
  display: inline-flex;
  flex: none;
  gap: var(--space-1-5);
}

.foot,
.cleanup {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  box-shadow: inset 0 0.5px 0 var(--stroke-1);
  font: var(--type-caption) var(--font-sans);
}

.cleanup {
  justify-content: space-between;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
  color: rgb(var(--text-2));
}

.more {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-2-5) var(--space-4);
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: rgb(var(--text-2));
  font: inherit;
  cursor: pointer;
}

.more:hover {
  color: rgb(var(--text-1));
  background: var(--surface-hover);
}

.limit {
  padding: var(--space-2) var(--space-4);
  color: rgb(var(--text-3));
}

@container (max-width: 520px) {
  .head {
    flex-wrap: wrap;
  }

  /* The summary keeps its line; the actions move under it. */
  .summary {
    flex-basis: 100%;
  }

  .actions {
    margin-inline-start: calc(
      calc(var(--space-8) + var(--space-2)) + var(--space-3)
    );
  }
}
</style>
