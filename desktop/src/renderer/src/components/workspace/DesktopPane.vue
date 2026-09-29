<script setup lang="ts">
/** Session-scoped native desktop targets. Controls go through ComputerUseService. */
import type {
  ComputerUseStatusView,
  UiTargetView,
} from '@emperor/core/runtime-contract'
import { Hand, Monitor, Pause, Play, Undo2, X } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { attachmentRawUrl } from '../../api/attachments'
import {
  agentPreviewStart,
  agentPreviewStop,
  hasCoreBridge,
  invokeCore,
  onAgentPreviewFrame,
  onCoreEvent,
} from '../../api/backend'
import {
  desktopAppId,
  desktopControlLabel,
  desktopLiveTargetIds,
  desktopPreviewNote,
  desktopTargetActions,
  desktopTargetsFor,
  type DesktopTargetAction,
} from './desktopPaneModel'

const props = defineProps<{ sessionId?: string | null }>()
const status = ref<ComputerUseStatusView | null>(null)
const loading = ref(true)
const busyTarget = ref<string | null>(null)
const error = ref('')
const preview = ref<{ attachmentId: string; title: string } | null>(null)
const closePreviewButton = ref<HTMLButtonElement | null>(null)
let previewOpener: HTMLButtonElement | null = null
const driver = computed(() =>
  status.value?.drivers.find((item) => item.driver === 'desktop'),
)
const targets = computed(() =>
  desktopTargetsFor(status.value?.targets ?? [], props.sessionId),
)

let alive = true
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe = () => {}

// Live frames of the windows the Agent controls (E-M16), as object URLs.
const liveFrames = ref<Record<string, string>>({})
const streaming = new Set<string>()
let stopFrames = () => {}

function syncLive(): void {
  const wanted = new Set(
    desktopLiveTargetIds(targets.value, status.value?.stopped === true),
  )
  for (const targetId of [...streaming])
    if (!wanted.has(targetId)) {
      streaming.delete(targetId)
      agentPreviewStop(targetId)
    }
  for (const targetId of wanted)
    if (!streaming.has(targetId)) {
      streaming.add(targetId)
      void agentPreviewStart(targetId)
    }
  // Drop frames of windows that are no longer listed.
  const listed = new Set(targets.value.map((target) => target.targetId))
  for (const [targetId, url] of Object.entries(liveFrames.value))
    if (!listed.has(targetId)) {
      URL.revokeObjectURL(url)
      const { [targetId]: _dropped, ...rest } = liveFrames.value
      liveFrames.value = rest
    }
}

function onLiveFrame(frame: { targetId: string; jpeg: Uint8Array }): void {
  if (!streaming.has(frame.targetId)) return
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(frame.jpeg)], { type: 'image/jpeg' }),
  )
  const previous = liveFrames.value[frame.targetId]
  liveFrames.value = { ...liveFrames.value, [frame.targetId]: url }
  if (previous) URL.revokeObjectURL(previous)
}

async function refresh(): Promise<void> {
  if (!hasCoreBridge()) {
    loading.value = false
    return
  }
  try {
    const next = await invokeCore('computerUse.status')
    if (alive) {
      status.value = next
      error.value = ''
    }
  } catch (cause) {
    if (alive)
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (alive) loading.value = false
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 60)
}

async function control(
  target: UiTargetView,
  action: DesktopTargetAction,
): Promise<void> {
  if (busyTarget.value) return
  busyTarget.value = target.targetId
  error.value = ''
  try {
    await invokeCore('computerUse.controlTarget', {
      targetId: target.targetId,
      action,
    })
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = null
  }
}

const actionLabels: Record<DesktopTargetAction, string> = {
  pause: '暂停',
  resume: '继续',
  takeover: '接管',
  handback: '交还',
  close: '结束操作',
}

function showPreview(target: UiTargetView, event: MouseEvent): void {
  if (!target.lastScreenshot) return
  previewOpener = event.currentTarget as HTMLButtonElement
  preview.value = {
    attachmentId: target.lastScreenshot.attachmentId,
    title: target.title || '窗口',
  }
  void nextTick(() => closePreviewButton.value?.focus())
}

function closePreview(): void {
  preview.value = null
  void nextTick(() => {
    if (previewOpener?.isConnected) previewOpener.focus()
    previewOpener = null
  })
}

watch(
  () => props.sessionId,
  () => void refresh(),
)
watch([targets, () => status.value?.stopped], syncLive)
onMounted(() => {
  stopFrames = onAgentPreviewFrame(onLiveFrame)
  unsubscribe = onCoreEvent((event) => {
    if (
      event &&
      typeof event === 'object' &&
      (event as { event?: unknown }).event === 'computer_use_changed'
    )
      scheduleRefresh()
  })
  void refresh()
})
onBeforeUnmount(() => {
  alive = false
  unsubscribe()
  stopFrames()
  for (const targetId of streaming) agentPreviewStop(targetId)
  streaming.clear()
  for (const url of Object.values(liveFrames.value)) URL.revokeObjectURL(url)
  if (refreshTimer !== null) clearTimeout(refreshTimer)
})
</script>

<template>
  <section class="desktop-pane" aria-label="电脑目标">
    <header class="desktop-pane-header">
      <Monitor :size="17" aria-hidden="true" />
      <div>
        <strong>当前会话的电脑窗口</strong>
        <p>窗口由 Emperor Computer Helper 连接</p>
      </div>
      <span class="target-count">{{ targets.length }}</span>
    </header>

    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="desktop-empty">正在读取电脑状态…</p>
    <p
      v-else-if="!status?.supported || status.platform !== 'macos'"
      class="desktop-empty"
    >
      当前平台尚未提供电脑窗口驱动。
    </p>
    <p v-else-if="!status.enabled" class="desktop-empty">
      电脑操作已关闭，可在设置中启用。
    </p>
    <p v-else-if="!driver?.available" class="desktop-empty">
      {{ driver?.reason || '电脑驱动当前不可用' }}
    </p>
    <p v-else-if="!targets.length" class="desktop-empty">
      当前会话没有桌面目标。Agent 绑定窗口后会显示在这里。
    </p>
    <div v-else class="desktop-target-list">
      <article
        v-for="target in targets"
        :key="target.targetId"
        class="desktop-target-card"
      >
        <div class="target-heading">
          <span class="target-name" :title="target.title">{{
            target.title || '未命名窗口'
          }}</span>
          <span class="target-state" :data-control="target.control">{{
            status.stopped ? '已急停' : desktopControlLabel(target)
          }}</span>
        </div>
        <p class="target-app" :title="desktopAppId(target)">
          {{ desktopAppId(target) }}
        </p>
        <div v-if="liveFrames[target.targetId]" class="target-live">
          <img
            :src="liveFrames[target.targetId]"
            :alt="`${target.title || '窗口'}的实时画面`"
          />
        </div>
        <button
          v-else-if="target.lastScreenshot"
          type="button"
          class="target-preview"
          :aria-label="`查看 ${target.title || '窗口'} 的最近截图`"
          @click="showPreview(target, $event)"
        >
          <img
            :src="attachmentRawUrl(target.lastScreenshot.attachmentId)"
            :alt="`${target.title || '窗口'}的最近截图`"
          />
        </button>
        <p v-else class="target-no-preview">
          暂无截图。Agent 截图后会显示最近一张。
        </p>
        <p class="target-live-note">
          {{
            desktopPreviewNote(
              target,
              Boolean(liveFrames[target.targetId]),
              status.stopped,
            )
          }}
        </p>
        <div
          class="target-actions"
          :aria-label="`${target.title || '窗口'}的控制操作`"
        >
          <button
            v-for="action in desktopTargetActions(target.control)"
            :key="action"
            type="button"
            :data-action="action"
            :disabled="busyTarget !== null"
            @click="control(target, action)"
          >
            <Pause v-if="action === 'pause'" :size="13" aria-hidden="true" />
            <Play
              v-else-if="action === 'resume'"
              :size="13"
              aria-hidden="true"
            />
            <Hand
              v-else-if="action === 'takeover'"
              :size="13"
              aria-hidden="true"
            />
            <Undo2
              v-else-if="action === 'handback'"
              :size="13"
              aria-hidden="true"
            />
            <X v-else :size="13" aria-hidden="true" />
            {{ actionLabels[action] }}
          </button>
        </div>
      </article>
    </div>
    <p v-if="driver?.missing.length" class="desktop-capability">
      当前缺少：{{ driver.missing.join('、') }}
    </p>
    <div
      v-if="preview"
      class="preview-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="`${preview.title}的最近截图`"
      @click.self="closePreview"
      @keydown.esc.stop.prevent="closePreview"
      @keydown.tab.prevent="closePreviewButton?.focus()"
    >
      <div class="preview-dialog">
        <header>
          <strong>{{ preview.title }}</strong>
          <button
            ref="closePreviewButton"
            type="button"
            aria-label="关闭截图"
            @click="closePreview"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </header>
        <img
          :src="attachmentRawUrl(preview.attachmentId)"
          :alt="`${preview.title}的最近截图`"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.desktop-pane {
  position: relative;
  height: 100%;
  overflow-y: auto;
  padding: var(--space-4);
  color: rgb(var(--label-primary));
}
.desktop-pane-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-l1);
}
.desktop-pane-header > div {
  min-width: 0;
  flex: 1;
}
.desktop-pane-header strong {
  font-size: var(--fs-s);
  font-weight: 600;
}
.desktop-pane-header p {
  margin: var(--space-0-5) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
}
.target-count {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border-radius: var(--radius-pill);
  background: rgb(var(--bg-layer-2));
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
}
.desktop-empty,
.desktop-error {
  margin: var(--space-4) 0;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}
.desktop-error {
  color: rgb(var(--danger));
}
.desktop-target-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-3);
}
.desktop-target-card {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
}
.target-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.target-name {
  overflow: hidden;
  font-size: var(--fs-s);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target-state {
  flex: none;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
}
.target-state[data-control='agent'] {
  color: rgb(var(--accent));
}
.target-app {
  margin: var(--space-1) 0 var(--space-2);
  overflow: hidden;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target-preview {
  display: block;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-base));
  cursor: zoom-in;
}
.target-preview img {
  display: block;
  width: 100%;
  max-height: 280px;
  object-fit: contain;
}
.target-live {
  overflow: hidden;
  border: 1px solid var(--border-l1);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-base));
}
.target-live img {
  display: block;
  width: 100%;
  max-height: 280px;
  object-fit: contain;
}
.target-live-note {
  margin: var(--space-1-5) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
.target-no-preview {
  display: grid;
  min-height: 110px;
  margin: 0;
  place-items: center;
  border: 1px dashed var(--border-l2);
  border-radius: var(--radius-row);
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  text-align: center;
}
.target-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-top: var(--space-3);
}
.target-actions button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1-5) var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
  color: rgb(var(--label-primary));
  font: var(--font-xs);
  cursor: pointer;
}
.target-actions button:hover:not(:disabled) {
  background: rgb(var(--bg-layer-3));
}
.target-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.target-actions button:focus-visible,
.target-preview:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}
.desktop-capability {
  margin: var(--space-3) 0 0;
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}
.preview-backdrop {
  position: fixed;
  z-index: var(--z-lightbox);
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-3);
  background: rgb(var(--bg-base) / 0.88);
}
.preview-dialog {
  display: flex;
  width: 100%;
  max-height: 100%;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-card);
  background: rgb(var(--bg-layer-1));
}
.preview-dialog header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--fs-xs);
}
.preview-dialog header button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: var(--radius-row);
  background: rgb(var(--bg-layer-2));
  color: rgb(var(--label-primary));
  cursor: pointer;
}
.preview-dialog img {
  display: block;
  width: 100%;
  min-height: 0;
  object-fit: contain;
}
</style>
