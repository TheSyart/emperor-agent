<script setup lang="ts">
import { computed, inject, onBeforeUnmount, shallowRef, watch } from 'vue'
import { ArrowUpRight, Info } from 'lucide-vue-next'
import { openResourceImages } from './resourceImages'
import { attachmentRawUrl } from '../../../api/attachments'
import { useChatContext } from '../chatContext'
import { requestResourceDetail, requestResourceOpen } from './resourceEvents'
import { PROVENANCE_LABEL, type DisplayResource } from './resourceModel'
import ResourceIcon from './ResourceIcon.vue'
import { LINK_STATUS_KEY, type LinkStatus } from '../parts/linkStatus'
const props = withDefaults(
  defineProps<{
    resource: DisplayResource
    compact?: boolean
    group?: readonly DisplayResource[]
  }>(),
  { compact: false },
)
const { sessionId } = useChatContext()
const links = inject(LINK_STATUS_KEY, null)
const fileStatus = shallowRef<LinkStatus | null>(null)
let statusGeneration = 0
watch(
  () => [props.resource, links?.version.value],
  async () => {
    const generation = ++statusGeneration
    fileStatus.value = null
    if (
      !links ||
      props.resource.attachmentId ||
      !['file', 'folder', 'image'].includes(props.resource.kind)
    )
      return
    const status = await links.status(
      props.resource.href,
      props.resource.sourceMessageId,
    )
    if (generation === statusGeneration) fileStatus.value = status
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  statusGeneration++
})
const resource = computed<DisplayResource>(() =>
  fileStatus.value
    ? {
        ...props.resource,
        available: fileStatus.value.state !== 'missing',
        ...(fileStatus.value.state === 'directory'
          ? { kind: 'folder' as const }
          : {}),
      }
    : props.resource,
)
const thumbnail = computed(() =>
  resource.value.attachmentId && resource.value.kind === 'image'
    ? attachmentRawUrl(resource.value.attachmentId)
    : null,
)
function open() {
  if (resource.value.available !== false)
    requestResourceOpen(resource.value, sessionId())
}
</script>
<template>
  <div
    class="resource-card"
    :data-resource-kind="resource.kind"
    :data-compact="compact || undefined"
    :data-missing="resource.available === false || undefined"
  >
    <div class="resource-glyph">
      <button
        v-if="thumbnail"
        type="button"
        class="resource-image-open"
        :aria-label="`放大图片：${resource.label}`"
        @click="openResourceImages(resource, sessionId(), group)"
      >
        <img :src="thumbnail" alt="" loading="lazy" /></button
      ><ResourceIcon v-else :resource="resource" :size="compact ? 22 : 26" />
    </div>
    <div class="resource-copy">
      <div class="resource-eyebrow">
        {{
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
        }}<span v-if="resource.status" class="status">{{
          resource.status
        }}</span>
      </div>
      <a
        class="resource-title"
        :href="resource.href || undefined"
        :title="resource.href || resource.label"
        :aria-disabled="resource.available === false || undefined"
        @click.prevent="open"
        >{{ resource.label }}</a
      >
      <p v-if="resource.description" class="resource-description">
        {{ resource.description }}
      </p>
      <div class="resource-meta">
        <span>{{
          resource.available === false
            ? '文件不存在'
            : PROVENANCE_LABEL[resource.provenance]
        }}</span
        ><span v-if="resource.bytes !== undefined"
          >{{ Math.max(1, Math.round(resource.bytes / 1024)) }} KB</span
        ><span v-if="resource.uses && resource.uses.length > 1"
          >{{ resource.uses.length }} 处引用</span
        >
      </div>
    </div>
    <div class="resource-actions">
      <button
        type="button"
        data-resource-detail
        :aria-label="`查看详情：${resource.label}`"
        title="查看详情"
        @click="requestResourceDetail(resource, sessionId())"
      >
        <Info :size="15" /></button
      ><button
        type="button"
        :aria-label="`打开：${resource.label}`"
        title="打开"
        :disabled="resource.available === false"
        @click="open"
      >
        <ArrowUpRight :size="15" />
      </button>
    </div>
  </div>
</template>
<style scoped>
.resource-image-open {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.resource-image-open img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-xs);
}
.resource-card {
  display: flex;
  position: relative;
  align-items: flex-start;
  gap: var(--space-4);
  min-width: 0;
  margin: var(--space-3) 0;
  padding: var(--space-5);
  border: 1px solid var(--stroke-2);
  border-radius: var(--radius-card);
  background: rgb(var(--surface-base));
  line-height: 1.5;
  transition: border-color var(--duration-fast) ease;
}
.resource-card:hover {
  border-color: rgb(var(--accent) / 0.3);
}
.resource-glyph {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-cell);
  color: rgb(var(--label-secondary));
  background: var(--surface-hover);
}
.resource-glyph img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}
.resource-copy {
  flex: 1;
  min-width: 0;
}
.resource-eyebrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  color: rgb(var(--label-tertiary));
  font: var(--font-xxs);
}
.resource-title {
  display: block;
  max-width: calc(100% - 52px);
  color: rgb(var(--label-primary));
  font: 600 var(--fs-s)/var(--lh-s) var(--font-sans);
  overflow-wrap: anywhere;
  cursor: pointer;
}
.resource-title:hover {
  color: rgb(var(--text-link));
}
.resource-description {
  margin: var(--space-1) 0 0;
  color: rgb(var(--label-secondary));
  font: var(--font-xs);
  overflow-wrap: anywhere;
}
.resource-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2-5);
  margin-top: var(--space-2);
  color: rgb(var(--label-tertiary));
  font: var(--font-xxs);
}
.resource-actions {
  position: absolute;
  right: var(--space-2);
  top: var(--space-2);
  display: flex;
  gap: var(--space-0-5);
}
.resource-actions button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}
.resource-actions button:hover {
  background: var(--surface-hover);
  color: rgb(var(--label-primary));
}
.resource-actions button:disabled {
  opacity: 0.35;
  cursor: default;
}
.resource-actions button:focus-visible,
.resource-title:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}
.status {
  border-radius: var(--radius-xs);
  padding: 0 var(--space-1);
  color: rgb(var(--text-link));
  background: rgb(var(--accent) / 0.1);
}
.resource-card[data-missing] .resource-title {
  color: rgb(var(--label-tertiary));
  text-decoration: line-through;
  cursor: default;
}
.resource-card[data-compact] {
  padding: var(--space-4);
  gap: var(--space-3-5);
}
.resource-card[data-compact] .resource-glyph {
  width: 32px;
  height: 36px;
}
.resource-card[data-compact] .resource-meta {
  margin-top: var(--space-1);
}
</style>
