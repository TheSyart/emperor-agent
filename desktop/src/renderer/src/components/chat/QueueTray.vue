<script setup lang="ts">
import type { QueuedPromptItem } from '../../types'

defineProps<{ items: QueuedPromptItem[] }>()

defineEmits<{
  edit: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
}>()
</script>

<template>
  <section
    v-if="items.length"
    class="queue-tray"
    aria-label="待处理消息队列"
    aria-live="polite"
  >
    <header>
      <span>消息队列</span>
      <em>{{ items.length }}</em>
    </header>
    <ol>
      <li v-for="item in items" :key="item.id">
        <div class="queue-copy">
          <span class="queue-state">
            {{ item.status === 'interjecting' ? '准备插入' : '已排队' }}
          </span>
          <p>{{ item.content }}</p>
          <small
            v-if="item.attachmentCount || item.requestedSkillNames.length || item.hasCapabilityRefs"
          >
            <span v-if="item.attachmentCount">附件 {{ item.attachmentCount }}</span>
            <span v-if="item.requestedSkillNames.length">
              Skill {{ item.requestedSkillNames.join('、') }}
            </span>
            <span
              v-if="item.hasCapabilityRefs && !item.requestedSkillNames.length"
            >
              能力引用
            </span>
          </small>
        </div>
        <details class="queue-menu">
          <summary aria-label="队列消息操作">•••</summary>
          <div role="menu">
            <button type="button" role="menuitem" @click="$emit('edit', item)">
              编辑消息
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="!item.supportsInterjection"
              @click="$emit('interject', item)"
            >
              插入当前执行
            </button>
            <button
              type="button"
              role="menuitem"
              class="danger"
              @click="$emit('cancel', item)"
            >
              删除
            </button>
          </div>
        </details>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.queue-tray {
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--fg);
  overflow: visible;
}

.queue-tray > header {
  min-height: 32px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 12px;
}

.queue-tray > header em {
  min-width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  border-radius: 9px;
  background: var(--paper-2);
  font-style: normal;
  font-variant-numeric: tabular-nums;
}

.queue-tray ol {
  max-height: 168px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-tray li {
  min-height: 56px;
  padding: 8px 8px 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}

.queue-tray li:last-child {
  border-bottom: 0;
}

.queue-copy {
  min-width: 0;
  flex: 1;
}

.queue-state {
  display: block;
  margin-bottom: 2px;
  color: var(--fg-subtle);
  font-size: 11px;
}

.queue-copy p {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 18px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.queue-copy small {
  display: flex;
  gap: 8px;
  margin-top: 3px;
  color: var(--fg-subtle);
  font-size: 11px;
}

.queue-menu {
  position: relative;
  flex: none;
}

.queue-menu summary {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: var(--fg-muted);
  list-style: none;
}

.queue-menu summary::-webkit-details-marker {
  display: none;
}

.queue-menu div {
  position: absolute;
  z-index: 20;
  right: 0;
  bottom: 36px;
  width: 164px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
}

.queue-menu button {
  width: 100%;
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--fg);
  text-align: left;
}

.queue-menu button:hover:not(:disabled),
.queue-menu button:focus-visible {
  background: var(--paper-2);
}

.queue-menu button.danger {
  color: var(--danger);
}

.queue-menu button:disabled {
  opacity: 0.45;
}
</style>
