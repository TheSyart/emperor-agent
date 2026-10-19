<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import { ArrowUpRight, Copy, RefreshCw, LocateFixed } from 'lucide-vue-next'
import { core } from '../../../api/http'
import { openImageViewer } from '../../ui/imageViewer'
import Modal from '../../ui/Modal.vue'
import Button from '../../ui/Button.vue'
import ResourceIcon from './ResourceIcon.vue'
import { createResourcePreviewState } from './previewState'
import { PROVENANCE_LABEL, type DisplayResource } from './resourceModel'
const props = defineProps<{ resource: DisplayResource; sessionId: string }>()
const emit = defineEmits<{
  close: []
  open: []
  'open-internal': []
  reveal: [nodeKey: string]
}>()
const open = ref(true)
const root = ref<HTMLElement | null>(null)
const reference = shallowRef<CoreOperationResult<'references.resolve'> | null>(
  null,
)
const copyStatus = ref('')
let mounted = true
const previewState = createResourcePreviewState(
  async (sessionId, resource, signal) => {
    reference.value = null
    if (['skill', 'plugin', 'mcp'].includes(resource.kind))
      return { state: 'ready', updatedAt: Date.now() }
    const resolved = await core('references.resolve', {
      sessionId,
      sourceMessageId: resource.sourceMessageId,
      href: resource.attachmentId
        ? `attachment:${resource.attachmentId}`
        : resource.href,
      label: resource.label,
    })
    if (signal.aborted) throw new Error('cancelled')
    reference.value = resolved
    if (!resolved.available)
      return {
        state: 'unavailable',
        reason: '文件不存在或当前无法访问。',
        updatedAt: Date.now(),
      }
    if (resource.attachmentId) return { state: 'ready', updatedAt: Date.now() }
    if (resolved.kind === 'web')
      return core('references.preview', { sessionId, referenceId: resolved.id })
    return { state: 'ready', updatedAt: Date.now() }
  },
)
const { preview, loading } = previewState
function load() {
  void previewState.load(props.sessionId, props.resource)
}
watch(() => [props.sessionId, props.resource], load, { immediate: true })
watch(open, (value) => {
  if (!value) emit('close')
})
const safeRaster = (url: string | undefined) =>
  url && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(url)
    ? url
    : undefined
const image = computed(() => safeRaster(preview.value?.thumbnailDataUrl))
function enlargePreview() {
  if (image.value)
    openImageViewer({
      owner: props.sessionId,
      items: [
        { id: props.resource.id, src: image.value, name: props.resource.label },
      ],
    })
}
const iconImage = computed(() => safeRaster(preview.value?.iconDataUrl))
const previewReason = computed(() => {
  const reason = preview.value?.reason
  const reasons: Record<string, string> = {
    timeout: '加载超时，可稍后重试。',
    network_failed: '网络连接失败，可检查连接后重试。',
    network_unavailable: '当前无法联网补充详情。',
    busy: '正在加载其他资源，请稍后重试。',
    not_found: '网页不存在，原始链接仍可打开。',
    access_denied: '无权读取该网页，详情不会使用浏览器登录状态。',
    http_error: '网站暂时无法提供详情。',
    blocked_url: '该地址无法通过公共网页预览读取。',
    response_too_large: '网页超过预览大小限制，仍可打开原始链接。',
    unsupported_content: '此链接不提供网页预览。',
    github_unavailable: 'GitHub 连接当前不可用，可在能力页检查。',
    github_plugin_disabled: 'GitHub 插件已停用，可在能力页启用后重试。',
    github_unauthenticated: 'GitHub 尚未登录，可在能力页检查连接。',
    reference_unavailable: '该引用已失效，请重新打开原消息。',
    cancelled: '加载已取消，可重新加载。',
    preview_failed: '暂时无法补充详情，原始链接仍可使用。',
    dns_failed: '找不到这个网站的地址，原始链接仍可打开。',
    icon_unavailable: '这个网站没有可用的图标。',
    gh_failed: 'GitHub 命令执行失败，可在能力页检查连接。',
    gh_unauthenticated: 'GitHub 尚未登录，可在能力页检查连接。',
    spawn_error: '无法启动所需的本机命令。',
  }
  // Never show a raw error code; unknown reasons get the generic sentence.
  return (reason && reasons[reason]) || '暂时无法补充详情，原始链接仍可使用。'
})
const status = computed(
  () => preview.value?.status || props.resource.status || '',
)
const statusText = computed(
  () =>
    (
      ({
        open: '已打开',
        closed: '已关闭',
        merged: '已合并',
        draft: '草稿',
        success: '成功',
        failure: '失败',
        cancelled: '已取消',
        completed: '已完成',
        queued: '排队中',
        in_progress: '运行中',
        timed_out: '已超时',
        action_required: '需处理',
        neutral: '中性',
        skipped: '已跳过',
        waiting: '等待中',
      }) as Record<string, string>
    )[status.value.toLowerCase()] ?? status.value,
)
const statusTone = computed(() =>
  /^(failure|timed_out|action_required)$/i.test(status.value)
    ? 'danger'
    : /^(success|merged|completed)$/i.test(status.value)
      ? 'ok'
      : 'accent',
)
const internal = computed(
  () =>
    props.resource.github?.repo &&
    ['pull_request', 'issue', 'run'].includes(props.resource.github.type),
)
async function copy() {
  try {
    await navigator.clipboard.writeText(
      reference.value?.tooltip || props.resource.href || props.resource.label,
    )
    if (mounted) copyStatus.value = '已复制'
  } catch {
    if (mounted) copyStatus.value = '复制失败，请手动选择地址'
  }
}
let previousFocus: HTMLElement | null = null
let dialogElement: HTMLElement | null = null
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !dialogElement) return
  const elements = [
    ...dialogElement.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input,[tabindex="0"]',
    ),
  ]
  const first = elements[0],
    last = elements.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null
  await nextTick()
  dialogElement = root.value?.closest<HTMLElement>('.dialog') ?? null
  dialogElement?.addEventListener('keydown', trap)
  dialogElement?.querySelector<HTMLElement>('button')?.focus()
})
onBeforeUnmount(() => {
  mounted = false
  previewState.clear()
  dialogElement?.removeEventListener('keydown', trap)
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>
<template>
  <Modal v-model:open="open" title="资源详情" :width="520">
    <div ref="root" class="resource-details" data-resource-dialog>
      <div class="identity">
        <img v-if="iconImage" :src="iconImage" alt="" /><ResourceIcon
          v-else
          :resource="resource"
          :session-id="sessionId"
          :size="21"
        /><span>{{
          resource.subtitle &&
          ['web', 'github', 'skill', 'plugin', 'mcp'].includes(resource.kind)
            ? resource.subtitle
            : resource.kind === 'folder'
              ? '目录'
              : resource.kind === 'image'
                ? '图片'
                : resource.kind === 'attachment'
                  ? '附件'
                  : '文件'
        }}</span>
      </div>
      <h2>{{ preview?.title || resource.label }}</h2>
      <span v-if="status" class="status" :data-tone="statusTone">{{
        statusText
      }}</span>
      <p
        v-if="preview?.description || resource.description"
        class="description"
      >
        {{ preview?.description || resource.description }}
      </p>
      <p v-if="loading" class="notice" role="status">正在加载详情…</p>
      <div
        v-if="preview && preview.state !== 'ready'"
        class="notice"
        role="status"
      >
        <p>{{ previewReason }}</p>
        <Button size="sm" @click="load"
          ><RefreshCw :size="13" />重新加载</Button
        >
      </div>
      <button
        v-if="image"
        type="button"
        class="preview-image-open"
        :aria-label="`放大图片：${resource.label}`"
        @click="enlargePreview"
      >
        <img class="preview-image" :src="image" :alt="resource.label" />
      </button>
      <dl>
        <div>
          <dt>
            {{
              resource.attachmentId
                ? '附件标识'
                : ['web', 'github'].includes(resource.kind)
                  ? '地址'
                  : '位置'
            }}
          </dt>
          <dd>{{ reference?.tooltip || resource.href || resource.label }}</dd>
        </div>
        <div>
          <dt>来自</dt>
          <dd>
            {{ PROVENANCE_LABEL[resource.provenance]
            }}<template v-if="resource.uses && resource.uses.length > 1">
              · {{ resource.uses.length }} 处记录</template
            >
          </dd>
        </div>
      </dl>
      <div v-if="resource.uses?.length" class="source-uses">
        <button
          v-for="(use, index) in resource.uses"
          :key="`${use.nodeKey}:${use.provenance}:${index}`"
          type="button"
          @click="emit('reveal', use.nodeKey)"
        >
          <LocateFixed :size="13" />{{ PROVENANCE_LABEL[use.provenance] }} ·
          定位出处
        </button>
      </div>
      <div class="actions">
        <Button
          variant="primary"
          size="sm"
          :disabled="reference?.available === false"
          @click="emit('open')"
          ><ArrowUpRight :size="14" />{{
            reference?.kind === 'external_file' || resource.attachmentId
              ? '在 Finder 中显示'
              : ['skill', 'plugin', 'mcp'].includes(resource.kind)
                ? '查看能力'
                : '打开'
          }}</Button
        ><Button
          v-if="internal"
          size="sm"
          variant="secondary"
          @click="emit('open-internal')"
          >在 Emperor 查看</Button
        ><Button size="sm" @click="copy"><Copy :size="13" />复制地址</Button>
      </div>
      <p v-if="copyStatus" class="notice" role="status">{{ copyStatus }}</p>
    </div>
  </Modal>
</template>
<style scoped>
.preview-image-open {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.resource-details {
  min-width: 0;
  color: rgb(var(--label-primary));
}
.identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
}
.identity img {
  width: 21px;
  height: 21px;
  object-fit: contain;
}
.resource-details h2 {
  margin: var(--space-3) 0;
  font: 600 20px/1.5 var(--font-sans);
  overflow-wrap: anywhere;
}
.description {
  margin: var(--space-3) 0;
  font: var(--font-s);
  color: rgb(var(--label-secondary));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.status[data-tone='danger'] {
  color: rgb(var(--danger));
}
.status[data-tone='ok'] {
  color: rgb(var(--ok));
}
.status {
  display: inline-block;
  padding: var(--space-0-5) var(--space-1-5);
  border-radius: var(--radius-xs);
  background: rgb(var(--accent-fill) / 0.12);
  color: rgb(var(--accent-strong));
  font: var(--font-xxs);
}
.notice {
  margin: var(--space-3) 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
}
.notice p {
  margin: 0 0 var(--space-2);
}
.preview-image {
  display: block;
  max-width: 100%;
  max-height: 340px;
  object-fit: contain;
  margin: var(--space-4) auto;
  border-radius: var(--radius-row);
}
.file-text {
  max-height: 320px;
  overflow: auto;
  padding: var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font: var(--font-code);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
dl {
  margin: var(--space-4) 0;
}
dl > div {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border-l1);
}
dt {
  color: rgb(var(--label-tertiary));
  font: var(--font-xxs);
  margin-bottom: var(--space-1);
}
dd {
  margin: 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.source-uses {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}
.source-uses button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border: 0;
  border-radius: var(--radius-row);
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-secondary));
  padding: var(--space-1) var(--space-2);
  font: var(--font-xxs);
  cursor: pointer;
}
.source-uses button:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}
</style>
