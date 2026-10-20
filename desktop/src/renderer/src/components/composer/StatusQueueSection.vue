<script setup lang="ts">
/**
 * StatusQueueSection — the queue section of the composer status bar's
 * popover (UI-S04). Each row previews one message. A queued message has
 * 插入当前执行 / 编辑 / 删除; a message the agent did not run (the turn before
 * it failed or was stopped, or the app restarted — KRN-02) waits as
 * 「待发送 · 上一轮失败」 and has 发送 / 编辑 / 丢弃 instead.
 *
 * Props: items. Emits: send, interject, edit, cancel (each with the item).
 */
import { computed } from 'vue'
import type { QueuedPromptItem } from '../../types'
import ReferencedText from '../conversation/parts/ReferencedText.vue'
import { DsEdit, DsSend, DsTrash } from '../icons/ds'
import IconButton from '../ui/IconButton.vue'
import {
  holdLabel,
  isHeld,
  orderedQueue,
  queueHeadline,
} from './statusBarModel'

const props = defineProps<{ items: QueuedPromptItem[] }>()

const emit = defineEmits<{
  send: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  edit: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
}>()

const ordered = computed(() => orderedQueue(props.items))
const headline = computed(() => queueHeadline(props.items))
</script>

<template>
  <section class="section" aria-label="待处理消息队列">
    <div class="head">
      <span class="title">队列</span>
      <span class="meta" role="status">{{ headline }}</span>
    </div>
    <ul class="list">
      <li v-for="item in ordered" :key="item.id" class="row">
        <span class="preview" :title="item.content">
          <span v-if="item.status === 'interjecting'" class="state"
            >准备插入 ·</span
          >
          <span v-else-if="isHeld(item)" class="state held"
            >{{ holdLabel(item) }} ·</span
          >
          <ReferencedText
            v-if="item.content"
            :text="item.content"
            :references="item.references"
          />
          <template v-else>（附件消息）</template>
        </span>
        <span v-if="isHeld(item)" class="actions">
          <IconButton
            label="发送排队消息"
            tooltip="发送"
            size="xs"
            @click="emit('send', item)"
          >
            <DsSend :size="14" />
          </IconButton>
          <IconButton label="编辑消息" size="xs" @click="emit('edit', item)">
            <DsEdit :size="14" />
          </IconButton>
          <IconButton
            label="丢弃排队消息"
            tooltip="丢弃"
            size="xs"
            @click="emit('cancel', item)"
          >
            <DsTrash :size="14" />
          </IconButton>
        </span>
        <span v-else class="actions">
          <IconButton
            label="插入当前执行"
            :tooltip="
              item.supportsInterjection
                ? '插入当前执行'
                : '包含附件或 Skill 的消息不支持插入当前执行'
            "
            size="xs"
            :disabled="!item.supportsInterjection"
            @click="emit('interject', item)"
          >
            <DsSend :size="14" />
          </IconButton>
          <IconButton label="编辑消息" size="xs" @click="emit('edit', item)">
            <DsEdit :size="14" />
          </IconButton>
          <IconButton
            label="删除排队消息"
            size="xs"
            @click="emit('cancel', item)"
          >
            <DsTrash :size="14" />
          </IconButton>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2-5) var(--space-3);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-6);
}

.title {
  flex: none;
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: 500;
  color: rgb(var(--text-3));
}

.meta {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
}

.list {
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-8);
}

.preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  margin-right: var(--space-1);
  color: rgb(var(--text-1));
}

.state.held {
  font-weight: 500;
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}
</style>
