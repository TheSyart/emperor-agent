<script setup lang="ts">
/**
 * Notification list under the sidebar bell (async chunk). Rows show the
 * source glyph, title, detail and relative time; clicking one marks it read
 * and navigates: a session → its conversation, a git receipt → that
 * session with the workspace 「审查」 pane, a scheduler run → /scheduler.
 * The shell is ui/Popover: anchored under the bell, dismissed on outside
 * click / focus and Escape (focus goes back to the bell).
 */
import Button from '../ui/Button.vue'
import Popover from '../ui/Popover.vue'
import {
  CircleAlert,
  CircleCheck,
  Clock,
  GitCommitHorizontal,
  MessageCircleQuestion,
} from 'lucide-vue-next'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  type Component,
} from 'vue'
import { useRouter } from 'vue-router'
import { useNotifications } from '../../composables/useNotifications'
import { sessionLocation } from '../../router'
import {
  notificationRelativeTime,
  type AppNotification,
} from '../../runtime/notifications'
import { requestWorkspace } from '../workspace/workspaceState'

defineProps<{ anchor: HTMLElement | null }>()
const open = defineModel<boolean>('open', { default: false })

const router = useRouter()
const { items, unreadCount, markRead, markAllRead, clear } = useNotifications()
const popover = ref<InstanceType<typeof Popover> | null>(null)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

function close(): void {
  open.value = false
}

const rows = computed(() =>
  items.value.map((item) => ({
    item,
    time: notificationRelativeTime(item.createdAt, now.value),
  })),
)

function glyph(item: AppNotification): Component {
  if (item.kind === 'scheduler') return Clock
  if (item.kind === 'git') return GitCommitHorizontal
  if (item.kind === 'pending') return MessageCircleQuestion
  return item.tone === 'error' ? CircleAlert : CircleCheck
}

async function openItem(item: AppNotification): Promise<void> {
  markRead([item.key])
  close()
  const target = item.target
  if (target.type === 'scheduler') {
    await router.push({ name: 'scheduler' }).catch(() => undefined)
    return
  }
  await router.push(sessionLocation(target.sessionId)).catch(() => undefined)
  if (target.type === 'review') requestWorkspace({ pane: 'review' })
}

/** Keep keyboard focus inside the panel after a header action disables itself. */
function afterHeaderAction(): void {
  void nextTick(() => popover.value?.panel?.focus())
}

function clearAll(): void {
  clear()
  afterHeaderAction()
}

function readAll(): void {
  markAllRead()
  afterHeaderAction()
}

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  clearInterval(clock)
})
</script>

<template>
  <Popover
    ref="popover"
    v-model:open="open"
    class="notifications"
    :anchor="anchor"
    label="通知"
    :width="340"
    :padded="false"
  >
    <header class="head">
      <span class="heading">通知</span>
      <Button size="sm" :disabled="!unreadCount" @click="readAll()">
        全部已读
      </Button>
      <Button size="sm" :disabled="!items.length" @click="clearAll()">
        清空
      </Button>
    </header>
    <ul v-if="rows.length" class="list">
      <li v-for="{ item, time } in rows" :key="item.key">
        <button
          type="button"
          class="row"
          :data-unread="!item.read || undefined"
          :data-tone="item.tone"
          @click="openItem(item)"
        >
          <component :is="glyph(item)" :size="16" class="glyph" />
          <span class="body">
            <span class="title">{{ item.title }}</span>
            <span v-if="item.detail" class="detail">{{ item.detail }}</span>
          </span>
          <span class="meta">
            <span class="time">{{ time }}</span>
            <span v-if="!item.read" class="unread" aria-hidden="true" />
          </span>
        </button>
      </li>
    </ul>
    <div v-else class="empty">暂无通知</div>
  </Popover>
</template>

<style scoped>
.head {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2-5);
}

.heading {
  flex: 1;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 600;
}

.head-action {
  padding: var(--space-0-5) var(--space-2);
  border: none;
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-secondary));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  cursor: pointer;
}

.head-action:hover:not(:disabled) {
  background: var(--surface-hover);
  color: rgb(var(--label-primary));
}

.head-action:disabled {
  opacity: 0.4;
  cursor: default;
}

.list {
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-2) var(--space-2-5);
  border: none;
  border-radius: var(--radius-cell);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover,
.row:focus-visible {
  outline: none;
  background: var(--surface-hover);
}

.glyph {
  flex: none;
  margin-top: var(--space-0-5);
  color: rgb(var(--label-tertiary));
}

.row[data-tone='error'] .glyph {
  color: rgb(var(--error));
}

.row[data-tone='warning'] .glyph {
  color: rgb(var(--accent));
}

.body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.title,
.detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title {
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-secondary));
}

.row[data-unread] .title {
  color: rgb(var(--label-primary));
  font-weight: 500;
}

.detail {
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-tertiary));
}

.meta {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-1);
}

.time {
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  color: rgb(var(--label-caption));
  white-space: nowrap;
}

.unread {
  width: var(--space-1-5);
  height: var(--space-1-5);
  border-radius: var(--radius-pill);
  background: rgb(var(--error));
}

.empty {
  padding: var(--space-6) var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-caption));
  text-align: center;
}
</style>
