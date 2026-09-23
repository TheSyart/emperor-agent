<script setup lang="ts">
/**
 * Notification list under the sidebar bell (async chunk). Rows show the
 * source glyph, title, detail and relative time; clicking one marks it read
 * and navigates: a session → its conversation, a git receipt → that
 * session with the workspace 「审查」 pane, a scheduler run → /scheduler.
 * Positioned like ui/Menu (chat/floatingMenu), dismissed on outside
 * click / focus and Escape.
 */
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
  toRef,
  type Component,
} from 'vue'
import { useRouter } from 'vue-router'
import { useNotifications } from '../../composables/useNotifications'
import { sessionLocation } from '../../router'
import {
  notificationRelativeTime,
  type AppNotification,
} from '../../runtime/notifications'
import { useFloatingMenu } from '../chat/floatingMenu'
import { requestWorkspace } from '../workspace/workspaceState'

const props = defineProps<{ anchor: HTMLElement | null }>()
const open = defineModel<boolean>('open', { default: false })

const router = useRouter()
const { items, unreadCount, markRead, markAllRead, clear } = useNotifications()
const panel = ref<HTMLElement | null>(null)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

function close(): void {
  open.value = false
}

const floating = useFloatingMenu({
  open,
  button: toRef(props, 'anchor'),
  menu: panel,
  fallbackWidth: 340,
  fallbackHeight: 320,
  onClose: close,
  prefer: () => 'bottom',
})

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

// Escape closes the popover wherever focus is: 清空 / 全部已读 disable
// themselves once used, and a disabled button drops focus to <body>, so a
// listener on the panel alone would stop hearing the key. Capture phase, so
// the popover (the topmost floating layer) wins over card / page handlers.
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  close()
  props.anchor?.focus()
}

/** Keep keyboard focus inside the panel after a header action disables itself. */
function afterHeaderAction(): void {
  void nextTick(() => panel.value?.focus())
}

function clearAll(): void {
  clear()
  afterHeaderAction()
}

function readAll(): void {
  markAllRead()
  afterHeaderAction()
}

onMounted(async () => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
  document.addEventListener('keydown', onDocumentKeydown, true)
  await nextTick()
  floating.position()
  floating.addListeners()
})

onBeforeUnmount(() => {
  clearInterval(clock)
  document.removeEventListener('keydown', onDocumentKeydown, true)
  floating.removeListeners()
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="panel"
      class="notifications ds-fade-in"
      role="dialog"
      aria-label="通知"
      tabindex="-1"
      :style="floating.style.value"
    >
      <header class="head">
        <span class="heading">通知</span>
        <button
          type="button"
          class="head-action"
          :disabled="!unreadCount"
          @click="readAll()"
        >
          全部已读
        </button>
        <button
          type="button"
          class="head-action"
          :disabled="!items.length"
          @click="clearAll()"
        >
          清空
        </button>
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
    </div>
  </Teleport>
</template>

<style scoped>
.notifications {
  position: fixed;
  z-index: var(--z-menu);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 340px;
  padding: var(--space-1);
  border: 1px solid var(--border-inverted);
  border-radius: var(--radius-card);
  background: rgb(var(--menu-fill));
  box-shadow: var(--shadow-lv3);
  color: rgb(var(--label-primary));
}

/* Focus only parks here after a header action; the panel is not a control. */
.notifications:focus {
  outline: none;
}

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
  background: var(--interactive-bg-hover);
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
  background: var(--interactive-bg-hover);
}

.glyph {
  flex: none;
  margin-top: var(--space-0-5);
  color: rgb(var(--label-tertiary));
}

.row[data-tone='error'] .glyph {
  color: rgb(var(--danger));
}

.row[data-tone='warning'] .glyph {
  color: rgb(var(--accent-fill));
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
  background: rgb(var(--danger));
}

.empty {
  padding: var(--space-6) var(--space-3);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--label-caption));
  text-align: center;
}
</style>
