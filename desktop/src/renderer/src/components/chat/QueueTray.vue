<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { QueuedPromptItem } from '../../types'
import { actionIcons } from '../../icons'

const props = defineProps<{ items: QueuedPromptItem[] }>()

const emit = defineEmits<{
  edit: [item: QueuedPromptItem]
  interject: [item: QueuedPromptItem]
  cancel: [item: QueuedPromptItem]
}>()

const tray = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
const visibleItem = computed(
  () =>
    [...props.items].sort(
      (left, right) => left.createdOrder - right.createdOrder,
    )[0] || null,
)
const legacyOverflow = computed(() => Math.max(0, props.items.length - 1))
const liveMessage = computed(() => {
  const item = visibleItem.value
  if (!item) return '消息队列已清空'
  const overflow = legacyOverflow.value
    ? `，另有 ${legacyOverflow.value} 条旧队列`
    : ''
  return `${item.status === 'interjecting' ? '准备插入' : '已排队'}：${item.content}${overflow}`
})

function edit(item: QueuedPromptItem): void {
  menuOpen.value = false
  emit('edit', item)
}

function closeMenu(): void {
  menuOpen.value = false
}

function closeFromOutside(event: PointerEvent): void {
  if (!menuOpen.value || tray.value?.contains(event.target as Node)) return
  closeMenu()
}

onMounted(() => document.addEventListener('pointerdown', closeFromOutside))
onBeforeUnmount(() =>
  document.removeEventListener('pointerdown', closeFromOutside),
)
</script>

<template>
  <section
    v-if="visibleItem"
    ref="tray"
    class="queue-tray"
    aria-label="待处理消息队列"
    @keydown.esc.stop="closeMenu"
  >
    <div class="queue-item">
      <component
        :is="actionIcons.queue"
        class="queue-leading-icon"
        :size="15"
        aria-hidden="true"
      />
      <div class="queue-copy">
        <span class="queue-state">
          {{ visibleItem.status === 'interjecting' ? '准备插入' : '已排队' }}
        </span>
        <p :title="visibleItem.content">{{ visibleItem.content }}</p>
        <small v-if="legacyOverflow">
          另有 {{ legacyOverflow }} 条旧队列
        </small>
      </div>
      <div class="queue-actions">
        <button
          type="button"
          class="queue-action queue-interject"
          :disabled="!visibleItem.supportsInterjection"
          :title="
            visibleItem.supportsInterjection
              ? '插入当前执行'
              : '包含附件或 Skill 的消息不支持插入当前执行'
          "
          aria-label="插入当前执行"
          @click="emit('interject', visibleItem)"
        >
          <component :is="actionIcons.interject" :size="14" />
          <span>插入当前执行</span>
        </button>
        <button
          type="button"
          class="queue-action queue-icon-action"
          title="删除排队消息"
          aria-label="删除排队消息"
          @click="emit('cancel', visibleItem)"
        >
          <component :is="actionIcons.remove" :size="15" />
        </button>
        <div class="queue-menu">
          <button
            type="button"
            class="queue-action queue-icon-action"
            aria-label="更多队列操作"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            @click="menuOpen = !menuOpen"
          >
            <component :is="actionIcons.more" :size="16" />
          </button>
          <div v-if="menuOpen" class="queue-menu-popover" role="menu">
            <button type="button" role="menuitem" @click="edit(visibleItem)">
              <component :is="actionIcons.edit" :size="14" />
              编辑消息
            </button>
          </div>
        </div>
      </div>
    </div>
    <span class="sr-only" aria-live="polite">{{ liveMessage }}</span>
  </section>
</template>

<style scoped>
.queue-tray {
  position: relative;
  z-index: 0;
  width: 100%;
  margin-bottom: -10px;
  padding: 0 8px 10px;
  border: 1px solid rgb(var(--border));
  border-radius: 14px 14px 10px 10px;
  background: rgb(var(--paper-2));
  color: rgb(var(--fg));
  overflow: visible;
}

.queue-item {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 9px;
}

.queue-leading-icon {
  flex: none;
  color: rgb(var(--fg-subtle));
}

.queue-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.queue-state {
  flex: none;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.queue-copy p {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--fg-muted));
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-copy small {
  flex: none;
  color: rgb(var(--fg-subtle));
  font-size: 11px;
}

.queue-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.queue-action {
  min-width: 30px;
  min-height: 30px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: rgb(var(--fg-muted));
  cursor: pointer;
}

.queue-action:hover:not(:disabled),
.queue-action:focus-visible {
  background: rgb(var(--bg-inset));
  color: rgb(var(--fg));
}

.queue-action:focus-visible {
  outline: 2px solid rgb(var(--accent) / 0.65);
  outline-offset: 1px;
}

.queue-action:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.queue-interject {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 8px;
  font-size: 11px;
}

.queue-icon-action {
  display: inline-grid;
  place-items: center;
  padding: 0;
}

.queue-menu {
  position: relative;
}

.queue-menu-popover {
  position: absolute;
  z-index: 20;
  right: 0;
  bottom: 34px;
  width: 142px;
  padding: 4px;
  border: 1px solid rgb(var(--border-strong));
  border-radius: 8px;
  background: rgb(var(--bg-elevated));
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
}

.queue-menu-popover button {
  width: 100%;
  min-height: 32px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--fg));
  text-align: left;
  cursor: pointer;
}

.queue-menu-popover button:hover,
.queue-menu-popover button:focus-visible {
  background: rgb(var(--paper-2));
  outline: none;
}

@media (max-width: 620px) {
  .queue-copy small,
  .queue-interject span {
    display: none;
  }

  .queue-interject {
    width: 30px;
    padding: 0;
  }
}
</style>
