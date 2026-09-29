<script setup lang="ts">
/**
 * ComputerUseView — expanded body for GUI tool rows: driver and approval
 * badges, the target (title + URL as plain text), a prominent "result
 * unknown" notice, the structured error with its hint, a screenshot
 * thumbnail when the result saved one, then the raw IN/OUT card. Rows of
 * an embedded-browser target offer 「在浏览器面板查看」, which opens the
 * workspace Browser pane on that Agent tab (if it is still open).
 */
import { computed, ref } from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import {
  moveAgentDownload,
  revealAgentDownload,
  saveAgentDownloadAs,
} from '../../../api/backend'
import type { ToolChatData } from '../../../conversation/types'
import Pill from '../../ui/Pill.vue'
import { requestWorkspace } from '../../workspace/workspaceState'
import GenericToolCard from './GenericToolCard.vue'
import {
  DOWNLOAD_STATE_LABEL,
  DRIVER_LABEL,
  OUTCOME_LABEL,
  computerUseBindingMismatch,
  computerUseMeta,
  computerUseRecordsText,
  computerUseUnknown,
  formatBytes,
} from './computerUseModel'

const props = defineProps<{ data: ToolChatData }>()
const meta = computed(() => computerUseMeta(props.data))
const unknown = computed(() => computerUseUnknown(meta.value))
const shot = computed(() => meta.value?.screenshot)
const agentTab = computed(() =>
  meta.value?.driver === 'embedded-browser' ? meta.value.targetId : undefined,
)

function showAgentTab(): void {
  if (agentTab.value)
    requestWorkspace({ pane: 'browser', agentTargetId: agentTab.value })
}

const mismatch = computed(() => computerUseBindingMismatch(props.data))
const recordsText = computed(() => computerUseRecordsText(props.data.name))
const download = computed(() => meta.value?.download)
const upload = computed(() => meta.value?.upload)
const revealError = ref('')
const movedTo = ref('')

async function revealDownload(): Promise<void> {
  const item = download.value
  if (!item) return
  revealError.value = ''
  try {
    await revealAgentDownload(item.downloadId)
  } catch (cause) {
    revealError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** 00 §7.5: or anywhere the user picks in the system save dialog. */
async function saveDownloadAs(): Promise<void> {
  const item = download.value
  if (!item) return
  revealError.value = ''
  try {
    const saved = await saveAgentDownloadAs(item.downloadId)
    if (saved !== null) movedTo.value = saved
  } catch (cause) {
    revealError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** 00 §7.5: the user moves the file into this conversation's workspace. */
async function moveDownload(): Promise<void> {
  const item = download.value
  if (!item) return
  revealError.value = ''
  try {
    movedTo.value = await moveAgentDownload(item.downloadId)
  } catch (cause) {
    revealError.value = cause instanceof Error ? cause.message : String(cause)
  }
}
</script>

<template>
  <div class="cu-view" data-testid="computer-use-view">
    <div v-if="meta" class="badges">
      <Pill v-if="meta.driver">{{
        DRIVER_LABEL[meta.driver] ?? meta.driver
      }}</Pill>
      <Pill v-if="meta.autoApproved" tone="accent">完全放行 · 自动放行</Pill>
      <Pill v-if="meta.granted" tone="accent">授权 · {{ meta.granted }}</Pill>
      <Pill
        v-if="meta.outcome && !unknown"
        :tone="meta.outcome === 'observed' ? 'default' : 'approval'"
        >{{ OUTCOME_LABEL[meta.outcome] ?? meta.outcome }}</Pill
      >
      <button
        v-if="agentTab"
        type="button"
        class="show-tab"
        @click="showAgentTab"
      >
        在浏览器面板查看
      </button>
    </div>
    <div v-if="meta?.title || meta?.url" class="target">
      <span v-if="meta.title" class="title">{{ meta.title }}</span>
      <span v-if="meta.url" class="url">{{ meta.url }}</span>
    </div>
    <div
      v-if="mismatch"
      class="mismatch"
      role="alert"
      data-testid="computer-use-binding-mismatch"
    >
      已拒绝代填：当前网址或应用与凭据登记的不一致，可能是仿冒页面。请核对地址，需要时在「设置
      › 电脑操作 › 凭据」中更新绑定。
    </div>
    <div
      v-if="recordsText"
      class="records-text"
      role="note"
      data-testid="computer-use-records-text"
    >
      输入的文字会进入任务记录；密码等私密内容请使用凭据代填。
    </div>
    <div v-if="unknown" class="unknown" role="note" data-outcome="unknown">
      结果不确定：这个动作可能已经发生。Agent 应先观察页面确认，不会自动重试。
    </div>
    <div v-if="meta?.error && !unknown" class="error" role="note">
      <span class="code">{{ meta.error.code }}</span>
      <span class="message">{{ meta.error.message }}</span>
      <span v-if="meta.error.hint" class="hint">{{ meta.error.hint }}</span>
    </div>
    <div
      v-if="download"
      class="download"
      :data-state="download.state"
      data-testid="computer-use-download"
    >
      <span class="download-name">{{ download.filename || '（无文件）' }}</span>
      <span class="download-meta"
        >{{ DOWNLOAD_STATE_LABEL[download.state] ?? download.state
        }}<template v-if="download.bytes > 0">
          · {{ formatBytes(download.bytes) }}</template
        ></span
      >
      <button
        v-if="download.state === 'completed'"
        type="button"
        class="download-reveal"
        @click="revealDownload"
      >
        在访达中显示
      </button>
      <button
        v-if="download.state === 'completed' && !movedTo"
        type="button"
        class="download-reveal"
        data-testid="computer-use-download-move"
        @click="moveDownload"
      >
        移到工作区
      </button>
      <button
        v-if="download.state === 'completed' && !movedTo"
        type="button"
        class="download-reveal"
        data-testid="computer-use-download-save-as"
        @click="saveDownloadAs"
      >
        另存为…
      </button>
      <span v-if="movedTo" class="download-meta" role="status"
        >已移到 {{ movedTo }}</span
      >
      <span v-if="revealError" class="download-error" role="alert">{{
        revealError
      }}</span>
    </div>
    <div
      v-if="upload"
      class="download"
      :data-state="upload.state"
      data-testid="computer-use-upload"
    >
      <span class="download-name">{{
        upload.files.length ? upload.files.join('、') : '（未选择文件）'
      }}</span>
      <span class="download-meta"
        >{{ upload.state === 'attached' ? '已由你选择并上传' : '你取消了选择'
        }}<template v-if="upload.bytes > 0">
          · {{ formatBytes(upload.bytes) }}</template
        ></span
      >
    </div>
    <a
      v-if="shot"
      class="shot"
      :href="attachmentRawUrl(shot.attachmentId)"
      target="_blank"
      rel="noreferrer"
      :title="`截图 ${shot.width}×${shot.height}`"
    >
      <img
        :src="attachmentRawUrl(shot.attachmentId)"
        :alt="`页面截图 ${shot.width}×${shot.height}`"
        loading="lazy"
      />
    </a>
    <GenericToolCard :data="data" />
  </div>
</template>

<style scoped>
.cu-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
}

.show-tab {
  margin-left: auto;
  padding: 0 var(--space-1);
  border-radius: var(--radius-row);
  color: rgb(var(--accent));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.show-tab:hover {
  text-decoration: underline;
}

.show-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.target {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.title {
  color: rgb(var(--label-primary));
  font-size: var(--fs-s);
  line-height: 22px;
  overflow-wrap: anywhere;
}

.url {
  color: rgb(var(--label-tertiary));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  line-height: 18px;
  word-break: break-all;
}

.mismatch {
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-card);
  background: rgb(var(--danger-soft));
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 20px;
}

.records-text {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.unknown,
.error {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-card);
  background: rgb(var(--approval-soft));
  color: rgb(var(--approval-line));
  font-size: var(--fs-xs);
  line-height: 20px;
}

.code {
  font-family: var(--font-mono);
}

.message {
  color: rgb(var(--label-primary));
}

.hint {
  color: rgb(var(--label-secondary));
}

.download {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-2) var(--space-2-5);
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-card);
  font-size: var(--fs-xs);
  line-height: 20px;
}

.download[data-state='refused'],
.download[data-state='too-large'],
.download[data-state='interrupted'],
.download[data-state='timed-out'] {
  background: rgb(var(--approval-soft));
}

.download-name {
  color: rgb(var(--label-primary));
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.download-meta {
  color: rgb(var(--label-tertiary));
}

.download-reveal {
  margin-left: auto;
  color: rgb(var(--accent));
}

.download-reveal:hover {
  text-decoration: underline;
}

.download-reveal:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.download-error {
  flex-basis: 100%;
  color: rgb(var(--danger));
}

.shot {
  display: block;
  align-self: flex-start;
  max-width: 100%;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  overflow: hidden;
  background: rgb(var(--code-block-bg));
}

.shot img {
  display: block;
  max-width: min(360px, 100%);
  max-height: 240px;
  width: auto;
  height: auto;
  object-fit: contain;
}
</style>
