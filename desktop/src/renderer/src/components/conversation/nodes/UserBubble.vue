<script setup lang="ts">
/**
 * UserBubble — right-aligned user bubble (UI-S03): --bubble-user fill,
 * r-xl, 10/16 padding, 15/26 text, at most 80% of the column, no border.
 * Attachments render above the bubble (image thumbnails / file Tags); copy +
 * edit-resend actions and the send time sit below, revealed on hover.
 *
 * Skill / plugin chips show as in the composer (ReferencedText); copying
 * gives their `/name` text and editing puts them back as chips.
 *
 * Props: node (user). Emits through chat context: editMessage(text).
 */
import { computed } from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import type { UserChatNode } from '../../../conversation/types'
import { useChatContext } from '../chatContext'
import { formatBytes } from '../chatFormat'
import MessageIconActions from '../parts/MessageIconActions.vue'
import ReferencedText from '../parts/ReferencedText.vue'
import DocumentIcon from '../../ui/DocumentIcon.vue'
import Tag from '../../ui/Tag.vue'
import { openResourceImages } from '../resources/resourceImages'
import { requestResourceDetail } from '../resources/resourceEvents'
import type { DisplayResource } from '../resources/resourceModel'

const props = defineProps<{ node: UserChatNode }>()
const { actions, sessionId } = useChatContext()

interface AttachmentView {
  id: string
  name: string
  image: boolean
  size?: number
}

const attachments = computed<AttachmentView[]>(() =>
  props.node.data.attachments.flatMap((raw) => {
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (id === '') return []
    const mime = typeof raw.mime === 'string' ? raw.mime : ''
    return [
      {
        id,
        name: typeof raw.name === 'string' ? raw.name : id,
        image: raw.kind === 'image' || mime.startsWith('image/'),
        ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
      },
    ]
  }),
)

const contentImages = computed(() =>
  props.node.data.content.flatMap((block) =>
    block.type === 'image' &&
    !attachments.value.some((a) => a.id === block.attachment.attachmentId)
      ? [block.attachment.attachmentId]
      : [],
  ),
)
const images = computed(() => [
  ...attachments.value.filter((a) => a.image).map((a) => a.id),
  ...contentImages.value,
])
const files = computed(() => attachments.value.filter((a) => !a.image))

const sourceLabel = computed(() => {
  if (props.node.data.steering) return '运行中插入'
  if (props.node.data.source === 'scheduler') return '定时任务'
  return props.node.data.source ?? ''
})
function enlarge(id: string): void {
  const group = images.value.map((id) =>
    attachmentResource(id, attachments.value.find((a) => a.id === id)?.name),
  )
  const resource = group.find((item) => item.attachmentId === id)
  if (resource) openResourceImages(resource, sessionId(), group)
}
function attachmentResource(
  id: string,
  name = id,
  image = true,
): DisplayResource {
  const attachment = attachments.value.find((item) => item.id === id)
  return {
    id: `attachment:${id}`,
    kind: image ? 'image' : 'attachment',
    href: `attachment:${id}`,
    attachmentId: id,
    label: name,
    subtitle: '附件',
    sourceMessageId: props.node.data.messageId,
    role: 'source',
    provenance: 'provided',
    ...(attachment?.size !== undefined ? { bytes: attachment.size } : {}),
  }
}
</script>

<template>
  <div class="user-row" data-time-hover-root>
    <div class="stack">
      <div v-if="images.length" class="images">
        <figure v-for="id in images" :key="id" class="image-item">
          <button
            type="button"
            class="image-open"
            :aria-label="`预览图片：${attachments.find((a) => a.id === id)?.name || '图片'}`"
            @click="enlarge(id)"
          >
            <img
              class="thumb"
              :src="attachmentRawUrl(id)"
              alt=""
              loading="lazy"
            />
          </button>
        </figure>
      </div>
      <div v-if="files.length" class="files">
        <Tag
          v-for="file in files"
          :key="file.id"
          class="file-tag"
          :label="file.name"
          @click="
            requestResourceDetail(
              attachmentResource(file.id, file.name, false),
              sessionId(),
            )
          "
        >
          <template #leading>
            <DocumentIcon :path="file.name" :size="16" />
          </template>
          <span class="file-name">{{ file.name }}</span>
          <span v-if="file.size !== undefined" class="file-size">{{
            formatBytes(file.size)
          }}</span>
        </Tag>
      </div>
      <div v-if="node.data.text" class="user-bubble">
        <ReferencedText
          :text="node.data.text"
          :references="node.data.references"
          :source-message-id="node.data.messageId"
        />
      </div>
      <span v-if="sourceLabel" class="source">{{ sourceLabel }}</span>
    </div>
    <MessageIconActions
      class="actions"
      :text="node.data.text"
      :time="node.data.time"
      clock="start"
      editable
      @edit="actions.editMessage"
    />
  </div>
</template>

<style scoped>
.image-item {
  margin: 0;
  width: 120px;
}
.user-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1-5);
}

.stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  min-width: 0;
  max-width: 80%;
}

.user-bubble {
  max-width: 100%;
  padding: var(--space-2-5) var(--space-4);
  border: none;
  border-radius: var(--r-xl);
  background: rgb(var(--bubble-user));
  color: rgb(var(--text-1));
  font: var(--type-body) var(--font-sans);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
.image-open {
  padding: 0;
  border: 0;
  border-radius: var(--radius-card);
  background: none;
  cursor: pointer;
}
.image-open:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.thumb {
  width: 120px;
  height: 120px;
  border: 1px solid var(--stroke-1);
  border-radius: var(--radius-card);
  object-fit: cover;
  background: rgb(var(--code-block-bg));
}

.files {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1-5);
}

.file-tag {
  max-width: 260px;
}

.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  flex: none;
  margin-left: var(--space-1-5);
  color: rgb(var(--text-3));
}

.source {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--text-3));
}

.actions {
  opacity: 0;
  transition: opacity var(--duration-instant) ease;
}

.user-row:hover .actions,
.user-row:focus-within .actions {
  opacity: 1;
}
</style>
