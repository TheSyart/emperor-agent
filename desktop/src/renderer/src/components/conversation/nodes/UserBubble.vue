<script setup lang="ts">
/**
 * UserBubble — dsh right-aligned user bubble: --bubble-user fill, radius 22,
 * 10/16 padding, 16/24 text, max min(525px, 82%). Attachments render above
 * the bubble (image thumbnails / file chips); copy + edit-resend actions
 * and the send time sit below, revealed on hover.
 *
 * Props: node (user). Emits through chat context: editMessage(text).
 */
import { computed } from 'vue'
import { attachmentRawUrl } from '../../../api/attachments'
import type { UserChatNode } from '../../../conversation/types'
import { DsPaperclip } from '../../icons/ds'
import { useChatContext } from '../chatContext'
import { formatBytes } from '../chatFormat'
import MessageIconActions from '../parts/MessageIconActions.vue'

const props = defineProps<{ node: UserChatNode }>()
const { actions } = useChatContext()

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
</script>

<template>
  <div class="user-row" data-time-hover-root>
    <div class="stack">
      <div v-if="images.length" class="images">
        <img
          v-for="id in images"
          :key="id"
          class="thumb"
          :src="attachmentRawUrl(id)"
          alt=""
          loading="lazy"
        />
      </div>
      <div v-if="files.length" class="files">
        <span v-for="file in files" :key="file.id" class="file-chip">
          <DsPaperclip :size="14" class="file-icon" />
          <span class="file-name">{{ file.name }}</span>
          <span v-if="file.size !== undefined" class="file-size">{{
            formatBytes(file.size)
          }}</span>
        </span>
      </div>
      <div v-if="node.data.text" class="user-bubble">{{ node.data.text }}</div>
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
  max-width: min(525px, 82%);
}

.user-bubble {
  max-width: 100%;
  padding: var(--space-2-5) var(--space-4);
  border-radius: var(--radius-composer);
  background: rgb(var(--bubble-user));
  color: rgb(var(--label-primary));
  font-size: var(--fs-base);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.thumb {
  width: 120px;
  height: 120px;
  border: 1px solid var(--border-l1);
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

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 260px;
  height: var(--space-8);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-cell);
  background: rgb(var(--bg-layer-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.file-icon {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.source {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
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
