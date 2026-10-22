<script setup lang="ts">
/**
 * QueueDock — dsh queue panel attached to the top of the composer card
 * (radius 12 12 0 0, tip fill, square bottom tucked under the card). A 36px
 * header counts the queued messages; each 36px row previews one message with
 * interject / edit / delete actions. A message the agent did not run (the
 * turn before it failed or was stopped, or the app restarted) waits as
 * 「待发送」 with send / edit / discard actions instead (KRN-02).
 */
import IconButton from '../ui/IconButton.vue'
import { computed, ref } from 'vue'
import type { QueuedPromptItem } from '../../types'
import { DsChevronDown, DsEdit, DsQueue, DsSend, DsTrash } from '../icons/ds'
import ReferencedText from '../conversation/parts/ReferencedText.vue'

const props = defineProps<{ items: QueuedPromptItem[] }>()

const emit = defineEmits<{
  edit: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
  send: [item: QueuedPromptItem]
}>()

const HOLD_LABELS: Record<
  NonNullable<QueuedPromptItem['holdReason']>,
  string
> = {
  'previous-turn-failed': '待发送 · 上一轮失败',
  'previous-turn-stopped': '待发送 · 上一轮已停止',
  interrupted: '待发送 · 应用重启前未发出',
}

function held(item: QueuedPromptItem): boolean {
  return item.status === 'failed-previous'
}

function holdLabel(item: QueuedPromptItem): string {
  return item.holdReason ? HOLD_LABELS[item.holdReason] : '待发送'
}

const expanded = ref(true)
const ordered = computed(() =>
  [...props.items].sort(
    (left, right) => left.createdOrder - right.createdOrder,
  ),
)
const headline = computed(() => {
  const count = ordered.value.length
  const interjecting = ordered.value.some(
    (item) => item.status === 'interjecting',
  )
  if (interjecting) return `${count} 条消息准备插入`
  return ordered.value.every(held)
    ? `${count} 条消息待发送`
    : `${count} 条消息排队中`
})
</script>

<template>
  <section v-if="ordered.length" class="queue-dock" aria-label="待处理消息队列">
    <div class="panel">
      <button
        type="button"
        class="header"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <DsQueue :size="14" class="lead" aria-hidden="true" />
        <span class="count" role="status">{{ headline }}</span>
        <DsChevronDown
          :size="14"
          class="chevron"
          :data-open="expanded || undefined"
          aria-hidden="true"
        />
      </button>
      <ul v-if="expanded" class="list">
        <li v-for="item in ordered" :key="item.id" class="row">
          <span class="preview" :title="item.content">
            <span v-if="item.status === 'interjecting'" class="state"
              >准备插入 ·</span
            >
            <span v-else-if="held(item)" class="state held"
              >{{ holdLabel(item) }} ·</span
            >
            <ReferencedText
              v-if="item.content"
              :text="item.content"
              :references="item.references"
            />
            <template v-else>（附件消息）</template>
          </span>
          <span v-if="held(item)" class="actions">
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
    </div>
  </section>
</template>

<style scoped>
.queue-dock {
  box-sizing: border-box;
  flex: none;
  width: calc(100% - 2 * var(--composer-clearance) - 2 * var(--dock-inset));
  max-width: calc(var(--composer-card-max) - 2 * var(--dock-inset));
  margin: 0 auto calc(0px - var(--composer-stack-gap) - 3px);
  padding: 0 var(--dock-inset);
}

.panel {
  position: relative;
  width: 100%;
  padding: var(--space-0-5) 0 var(--space-1);
  overflow: hidden;
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  background: rgb(var(--tip-fill));
}

.panel::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--stroke-1);
  border-bottom: none;
  border-radius: inherit;
  pointer-events: none;
}

.header {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--text-1));
  text-align: left;
  cursor: pointer;
}

.header:focus-visible {
  outline: 2px solid rgb(var(--text-3));
  outline-offset: -2px;
}

.lead {
  flex: none;
  color: rgb(var(--text-3));
}

.count {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--space-6);
  font-weight: var(--weight-medium);
}

.chevron {
  flex: none;
  color: rgb(var(--text-3));
  transform: rotate(180deg);
  transition: transform var(--motion-fast) ease;
}

.chevron[data-open] {
  transform: none;
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
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: var(--space-1) calc(var(--space-1) + 1px) var(--space-1)
    var(--space-3);
  box-shadow: inset 0 1px 0 var(--stroke-1);
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
  color: rgb(var(--text-link));
}

.state.held {
  color: rgb(var(--text-2));
  font-weight: var(--weight-medium);
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}
</style>
