<script setup lang="ts">
/**
 * QueueDock — dsh queue panel attached to the top of the composer card
 * (radius 12 12 0 0, tip fill, square bottom tucked under the card). A 36px
 * header counts the queued messages; each 36px row previews one message with
 * interject / edit / delete actions.
 */
import { computed, ref } from 'vue'
import type { QueuedPromptItem } from '../../types'
import { DsChevronDown, DsEdit, DsQueue, DsSend, DsTrash } from '../icons/ds'

const props = defineProps<{ items: QueuedPromptItem[] }>()

const emit = defineEmits<{
  edit: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
}>()

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
  return interjecting ? `${count} 条消息准备插入` : `${count} 条消息排队中`
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
            {{ item.content || '（附件消息）' }}
          </span>
          <span class="actions">
            <button
              type="button"
              class="action"
              :disabled="!item.supportsInterjection"
              :title="
                item.supportsInterjection
                  ? '插入当前执行'
                  : '包含附件或 Skill 的消息不支持插入当前执行'
              "
              aria-label="插入当前执行"
              @click="emit('interject', item)"
            >
              <DsSend :size="14" />
            </button>
            <button
              type="button"
              class="action"
              title="编辑消息"
              aria-label="编辑消息"
              @click="emit('edit', item)"
            >
              <DsEdit :size="14" />
            </button>
            <button
              type="button"
              class="action"
              title="删除排队消息"
              aria-label="删除排队消息"
              @click="emit('cancel', item)"
            >
              <DsTrash :size="14" />
            </button>
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
  border: 1px solid var(--border-l1);
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
  color: rgb(var(--label-primary));
  text-align: left;
  cursor: pointer;
}

.header:focus-visible,
.action:focus-visible {
  outline: 2px solid rgb(var(--label-tertiary));
  outline-offset: -2px;
}

.lead {
  flex: none;
  color: rgb(var(--label-tertiary));
}

.count {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: var(--space-6);
  font-weight: 500;
}

.chevron {
  flex: none;
  color: rgb(var(--label-tertiary));
  transform: rotate(180deg);
  transition: transform var(--duration-ds-fast) ease;
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
  box-shadow: inset 0 1px 0 var(--border-l1);
}

.preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  color: rgb(var(--accent-strong));
}

.actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0-5);
}

.action {
  display: inline-grid;
  place-items: center;
  width: var(--space-7);
  height: var(--space-7);
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: rgb(var(--label-tertiary));
  cursor: pointer;
}

.action:hover:not(:disabled) {
  background: var(--interactive-bg-hover);
  color: rgb(var(--label-primary));
}

.action:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
