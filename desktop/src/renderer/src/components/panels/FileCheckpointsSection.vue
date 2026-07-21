<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CoreOperationResult } from '@emperor/core'
import { core } from '../../api/http'
import { checkpointIcons } from '../../icons'

const AlertCircle = checkpointIcons.alert
const CheckCircle2 = checkpointIcons.ok
const FileClock = checkpointIcons.file
const LoaderCircle = checkpointIcons.loading
const RefreshCcw = checkpointIcons.refresh
const RotateCcw = checkpointIcons.rewind
const TriangleAlert = checkpointIcons.warning

type ListPayload = CoreOperationResult<'fileCheckpoints.list'>
type Checkpoint = ListPayload['checkpoints'][number]
type Preview = CoreOperationResult<'fileCheckpoints.preview'>
type GitRewindResult = CoreOperationResult<'fileCheckpoints.rewindGit'>

const props = defineProps<{ sessionId: string }>()
const payload = ref<ListPayload | null>(null)
const preview = ref<Preview | null>(null)
const loading = ref(false)
const previewingId = ref('')
const rewindingId = ref('')
const error = ref('')
const notice = ref('')

const checkpoints = computed(() => payload.value?.checkpoints || [])

watch(
  () => props.sessionId,
  () => {
    preview.value = null
    void refresh()
  },
  { immediate: true },
)

defineExpose({ refresh })

async function refresh() {
  if (!props.sessionId || loading.value) return
  loading.value = true
  error.value = ''
  try {
    payload.value = await core('fileCheckpoints.list', {
      sessionId: props.sessionId,
    })
  } catch (reason) {
    error.value = message(reason)
  } finally {
    loading.value = false
  }
}

async function previewRewind(checkpoint: Checkpoint) {
  if (previewingId.value || rewindingId.value) return
  previewingId.value = checkpoint.id
  preview.value = null
  notice.value = ''
  error.value = ''
  try {
    preview.value = await core('fileCheckpoints.preview', {
      sessionId: props.sessionId,
      checkpointId: checkpoint.id,
    })
  } catch (reason) {
    error.value = message(reason)
  } finally {
    previewingId.value = ''
  }
}

async function confirmRewind() {
  const current = preview.value
  if (!current?.canRewind || rewindingId.value) return
  rewindingId.value = current.checkpoint.id
  error.value = ''
  notice.value = ''
  try {
    await core('fileCheckpoints.rewind', {
      sessionId: props.sessionId,
      checkpointId: current.checkpoint.id,
      confirmed: true,
    })
    notice.value = '文件已恢复到本次工具调用之前的状态。'
    preview.value = null
    await refresh()
  } catch (reason) {
    error.value = message(reason)
  } finally {
    rewindingId.value = ''
  }
}

async function confirmGitRewind() {
  const current = preview.value
  if (!current?.canRewind || !current.git?.canRewind || rewindingId.value)
    return
  rewindingId.value = current.checkpoint.id
  error.value = ''
  notice.value = ''
  try {
    const result: GitRewindResult = await core('fileCheckpoints.rewindGit', {
      sessionId: props.sessionId,
      checkpointId: current.checkpoint.id,
      confirmed: true,
      confirmedGitRisk: true,
      previewRevision: current.git.revision,
      dirtyStrategy: current.git.requiresStash ? 'stash' : 'abort',
    })
    const refs = [
      result.git.rescue.headRef,
      result.git.rescue.indexRef,
      result.git.rescue.stashRef,
    ].filter(Boolean)
    notice.value = `Git HEAD 与文件已软回退。救援引用：${refs.join(' · ')}`
    preview.value = null
    await refresh()
  } catch (reason) {
    error.value = message(reason)
  } finally {
    rewindingId.value = ''
  }
}

function checkpointTitle(checkpoint: Checkpoint): string {
  const count = checkpoint.changes.length
  return `${checkpoint.toolName} · ${count} 个文件变化`
}

function checkpointStatus(checkpoint: Checkpoint): string {
  if (checkpoint.status === 'rewound') return '已回退'
  if (checkpoint.quotaTruncated) return '内容不完整'
  return '可预览'
}

function conflictLabel(reason: Preview['conflicts'][number]['reason']): string {
  if (reason === 'current_state_changed') return '工作区内容已变化'
  if (reason === 'symlink_unsupported') return '路径已变为符号链接'
  if (reason === 'path_unavailable') return '当前路径不可读取'
  if (reason === 'before_content_unavailable') return '回退制品不可用或校验失败'
  return '回退后的制品不可用或校验失败'
}

function gitReasonLabel(reason: NonNullable<Preview['git']>['reason']): string {
  if (reason === 'ready') return 'Git 安全检查通过'
  if (reason === 'file_conflict') return '文件冲突已阻止 Git 操作'
  if (reason === 'capture_unavailable') return '本检查点没有可用 Git 状态'
  if (reason === 'repository_changed') return 'Git 仓库身份已变化'
  if (reason === 'git_operation_in_progress') return 'Git 操作正在进行'
  if (reason === 'unmerged_index') return 'index 存在未合并项'
  if (reason === 'submodule_unsupported') return '暂不支持 submodule 回退'
  if (reason === 'sparse_checkout_unsupported')
    return '暂不支持 sparse checkout'
  if (reason === 'target_not_ancestor') return '目标 HEAD 不是当前 HEAD 的祖先'
  if (reason === 'stash_filter_unsupported')
    return '项目 filter 使自动 stash 不安全'
  if (reason === 'stash_volume_exceeded')
    return '脏文件体积超过 128 MiB stash 上限'
  if (reason === 'evaluation_only') return '当前仅评估，不允许修改 Git'
  return 'Git 预览失败'
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
</script>

<template>
  <section class="diagnostics-group checkpoint-section">
    <div class="diagnostics-group-head checkpoint-head">
      <div>
        <strong>文件检查点（Beta）</strong>
        <span>文件回退保持独立；可选 Git 软回退绝不使用 hard reset</span>
      </div>
      <button
        class="checkpoint-icon-button"
        :disabled="loading"
        title="刷新文件检查点"
        aria-label="刷新文件检查点"
        @click="refresh"
      >
        <LoaderCircle v-if="loading" :size="15" class="spin" />
        <RefreshCcw v-else :size="15" />
      </button>
    </div>

    <div class="diagnostics-group-rows checkpoint-rows">
      <div v-if="error" class="checkpoint-message checkpoint-error">
        <AlertCircle :size="17" />
        <span>{{ error }}</span>
      </div>
      <div v-if="notice" class="checkpoint-message checkpoint-ok">
        <CheckCircle2 :size="17" />
        <span>{{ notice }}</span>
      </div>
      <div
        v-if="payload?.reconciliation?.failed"
        class="checkpoint-message checkpoint-warning"
      >
        <TriangleAlert :size="17" />
        <span>
          {{ payload.reconciliation.failed }}
          个中断检查点无法安全对账，原记录已保留。
        </span>
      </div>
      <div
        v-if="payload?.gitReconciliation?.interrupted"
        class="checkpoint-message checkpoint-warning"
      >
        <TriangleAlert :size="17" />
        <span>
          {{ payload.gitReconciliation.interrupted }} 个 Git
          软回退在进程重启前未完成；系统未自动修改仓库，请按救援引用人工检查。
        </span>
      </div>
      <div
        v-if="payload?.gitDiagnostics?.corruptJournals"
        class="checkpoint-message checkpoint-warning"
      >
        <TriangleAlert :size="17" />
        <span>
          已隔离 {{ payload.gitDiagnostics.corruptJournals }} 个损坏的 Git
          软回退事务日志；未自动修改仓库。备份：
          {{
            payload.gitDiagnostics.lastCorruptBackup ||
            '隔离失败，请检查磁盘权限'
          }}
        </span>
      </div>
      <div v-if="payload && !payload.enabled" class="checkpoint-empty">
        <FileClock :size="18" />
        <div>
          <strong>默认关闭</strong>
          <span>
            在 emperor.local.json 设置 workspace.fileCheckpoints.enabled=true
            后重启。
          </span>
        </div>
      </div>
      <div
        v-else-if="payload && !checkpoints.length && !loading"
        class="checkpoint-empty"
      >
        <FileClock :size="18" />
        <div>
          <strong>当前会话还没有文件检查点</strong>
          <span
            >启用后，write_file、edit_file、delete_file、rename_file 和
            apply_patch 会自动记录。</span
          >
        </div>
      </div>

      <article
        v-for="checkpoint in checkpoints"
        :key="checkpoint.id"
        class="checkpoint-card"
      >
        <div class="checkpoint-card-head">
          <FileClock :size="17" />
          <div>
            <strong>{{ checkpointTitle(checkpoint) }}</strong>
            <span
              >{{ formatTime(checkpoint.createdAt) }} ·
              {{ formatBytes(checkpoint.storedBytes) }}</span
            >
          </div>
          <code>{{ checkpointStatus(checkpoint) }}</code>
        </div>
        <div class="checkpoint-paths">
          <span
            v-for="change in checkpoint.changes"
            :key="`${checkpoint.id}:${change.path}`"
            :title="change.path"
          >
            {{ change.kind }} · {{ change.path }}
          </span>
        </div>
        <div v-if="checkpoint.status === 'ready'" class="checkpoint-actions">
          <button
            class="checkpoint-button"
            data-action="preview-rewind"
            :disabled="Boolean(previewingId || rewindingId)"
            @click="previewRewind(checkpoint)"
          >
            <LoaderCircle
              v-if="previewingId === checkpoint.id"
              :size="14"
              class="spin"
            />
            <RotateCcw v-else :size="14" />
            预览回退
          </button>
        </div>

        <div
          v-if="preview?.checkpoint.id === checkpoint.id"
          class="checkpoint-preview"
          :class="{ blocked: !preview.canRewind }"
        >
          <div class="checkpoint-preview-title">
            <CheckCircle2 v-if="preview.canRewind" :size="17" />
            <TriangleAlert v-else :size="17" />
            <strong>
              {{
                preview.canRewind
                  ? '哈希校验通过，可以回退'
                  : '检测到冲突，已禁止回退'
              }}
            </strong>
          </div>
          <div v-if="preview.conflicts.length" class="checkpoint-conflicts">
            <span
              v-for="conflict in preview.conflicts"
              :key="`${checkpoint.id}:${conflict.path}:${conflict.reason}`"
            >
              {{ conflict.path || '检查点' }} ·
              {{ conflictLabel(conflict.reason) }}
            </span>
          </div>
          <button
            v-if="preview.canRewind"
            class="checkpoint-button checkpoint-danger"
            data-action="confirm-rewind"
            :disabled="Boolean(rewindingId)"
            @click="confirmRewind"
          >
            <LoaderCircle v-if="rewindingId" :size="14" class="spin" />
            <RotateCcw v-else :size="14" />
            确认回退这些文件
          </button>
          <div v-if="preview.git" class="checkpoint-git-preview">
            <div class="checkpoint-preview-title">
              <CheckCircle2 v-if="preview.git.canRewind" :size="17" />
              <TriangleAlert v-else :size="17" />
              <strong>{{ gitReasonLabel(preview.git.reason) }}</strong>
            </div>
            <span v-if="preview.git.commitsToRewind">
              将软回退 {{ preview.git.commitsToRewind }} 个提交；提交内容不会被
              hard reset 删除。
            </span>
            <span v-else>HEAD 不移动；index 仍会明确 unstage。</span>
            <span v-if="preview.git.requiresStash">
              受管路径外有改动，确认后先创建并保留 rescue stash：
              {{ preview.git.unrelatedDirtyPaths.join(' · ') }}
            </span>
            <span v-if="preview.git.requiresStash">
              待保护脏文件约 {{ formatBytes(preview.git.dirtyBytes) }}。
            </span>
            <span v-if="!preview.git.stashSafe && preview.git.requiresStash">
              仓库配置了 filter，自动 stash 已禁止。
            </span>
            <button
              v-if="preview.git.canRewind"
              class="checkpoint-button checkpoint-danger"
              data-action="confirm-git-rewind"
              :disabled="Boolean(rewindingId)"
              @click="confirmGitRewind"
            >
              <LoaderCircle v-if="rewindingId" :size="14" class="spin" />
              <RotateCcw v-else :size="14" />
              {{
                preview.git.requiresStash
                  ? '确认 stash、Git 软回退与文件回退'
                  : '确认 Git 软回退与文件回退'
              }}
            </button>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.checkpoint-section {
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius);
  overflow: hidden;
}

.checkpoint-head,
.checkpoint-card-head,
.checkpoint-message,
.checkpoint-empty,
.checkpoint-actions,
.checkpoint-preview-title {
  display: flex;
  align-items: center;
}

.checkpoint-head {
  justify-content: space-between;
  gap: var(--space-3);
}

.checkpoint-head > div,
.checkpoint-card-head > div,
.checkpoint-empty > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}

.checkpoint-head span,
.checkpoint-card-head span,
.checkpoint-empty span {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
}

.checkpoint-icon-button,
.checkpoint-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid rgb(var(--border));
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.checkpoint-icon-button {
  width: 30px;
  height: 30px;
}

.checkpoint-button {
  padding: var(--space-2) 10px;
  font-size: var(--font-size-sm);
}

.checkpoint-icon-button:disabled,
.checkpoint-button:disabled {
  cursor: default;
  opacity: 0.5;
}

.checkpoint-rows {
  display: grid;
}

.checkpoint-git-preview {
  display: grid;
  gap: 8px;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid rgb(var(--border));
}

.checkpoint-git-preview > span {
  color: rgb(var(--fg-muted));
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.checkpoint-message,
.checkpoint-empty,
.checkpoint-card {
  gap: var(--space-3);
  padding: var(--space-3) 14px;
  border-top: 1px solid rgb(var(--border));
}

.checkpoint-error {
  color: rgb(var(--danger));
}

.checkpoint-ok {
  color: rgb(var(--ok));
}

.checkpoint-warning {
  color: rgb(var(--warn));
}

.checkpoint-card-head {
  gap: var(--space-2);
}

.checkpoint-card-head code {
  margin-left: auto;
  white-space: nowrap;
}

.checkpoint-paths,
.checkpoint-conflicts {
  display: grid;
  gap: 4px;
  margin: var(--space-2) 0 0 26px;
  color: rgb(var(--fg-muted));
  font:
    12px/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
}

.checkpoint-paths span,
.checkpoint-conflicts span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.checkpoint-actions {
  justify-content: flex-end;
  margin-top: var(--space-3);
}

.checkpoint-preview {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: rgb(var(--ok) / 0.09);
}

.checkpoint-preview.blocked {
  background: rgb(var(--warn) / 0.1);
}

.checkpoint-preview-title {
  gap: var(--space-2);
  font-size: var(--font-size-md);
}

.checkpoint-danger {
  justify-self: end;
  border-color: rgb(var(--danger) / 0.55);
  color: rgb(var(--danger));
}

.spin {
  animation: checkpoint-spin 0.9s linear infinite;
}

@keyframes checkpoint-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
