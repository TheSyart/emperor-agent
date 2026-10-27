<script setup lang="ts">
/**
 * GroupPage — a group, `/groups/:groupId` (GRP-08, 预览 B 第 3 步,
 * docs/design/agent-contacts.md § 群聊页): the header (name, 「N 人」, the
 * collaboration, 「本轮 $… · 不设上限」, 停止 ⌘. and 群设置), the message
 * flow, the live bar and the composer, and the members on the right.
 * ⌘. stops the turn while one runs (never while a dialog is open).
 * 「过程 ›」 opens the member's own session read-only; a member row its
 * profile. useGroupRoom keeps the state.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Settings2 } from 'lucide-vue-next'
import { useAppContext } from '../../composables/useAppContext'
import { useContactDirectory } from '../contacts/contactDirectory'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import type { SettingsModalSection } from '../settings/settingsSections'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import IconButton from '../ui/IconButton.vue'
import Kbd from '../ui/Kbd.vue'
import Notice from '../ui/Notice.vue'
import { modalLayerCount } from '../ui/modalStack'
import GroupComposer from './GroupComposer.vue'
import GroupConversation from './GroupConversation.vue'
import GroupLiveBar from './GroupLiveBar.vue'
import GroupMembers from './GroupMembers.vue'
import {
  collaborationLabel,
  speechCount,
  spendLabel,
  turnEndedAt,
} from './groupModel'
import { useGroupRoom } from './useGroupRoom'

const route = useRoute()
const router = useRouter()
const ctx = useAppContext()
const settingsRoute = useSettingsRoute()
const directory = useContactDirectory()

const groupId = computed(() => String(route.params.groupId ?? ''))
const room = useGroupRoom(() => groupId.value, {
  showError: (error, fallback) => ctx.showError(error, fallback),
})

const group = room.group
const names = computed<Record<string, string>>(() =>
  Object.fromEntries(
    room.members.value.map((member) => [member.id, member.name]),
  ),
)
const addable = computed(() =>
  directory.contacts.value.filter(
    (contact) => !room.members.value.some((member) => member.id === contact.id),
  ),
)
const speeches = computed(() =>
  speechCount(room.messages.value, room.turn.value?.turnId),
)
const endedAt = computed(() =>
  turnEndedAt(room.messages.value, room.turn.value?.turnId),
)

// ── scrolling: stay at the bottom while the user is there ───────────────
const scroller = ref<HTMLElement | null>(null)
let pinned = true
function onScroll(): void {
  const element = scroller.value
  if (!element) return
  pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 48
}
watch(
  () => [room.messages.value.length, room.asks.value.length],
  async () => {
    if (!pinned) return
    await nextTick()
    const element = scroller.value
    if (element) element.scrollTop = element.scrollHeight
  },
)
watch(groupId, () => (pinned = true))

// ── actions ─────────────────────────────────────────────────────────────
function openProcess(contactId: string): void {
  const sessionId = room.members.value.find(
    (member) => member.id === contactId,
  )?.memberSessionId
  if (!sessionId) return
  void router
    .push({ name: 'chat', params: { sessionId } })
    .catch(() => undefined)
}

function openProfile(contactId: string): void {
  void router
    .push({ name: 'contact', params: { id: contactId } })
    .catch(() => undefined)
}

function openGroupSettings(): void {
  void router
    .push({ name: 'group-settings', params: { groupId: groupId.value } })
    .catch(() => undefined)
}

function openSettings(section: SettingsModalSection): void {
  void settingsRoute.openSettings(section)
}

function backHome(): void {
  void router.push({ name: 'contacts' }).catch(() => undefined)
}

function stop(): void {
  if (room.running.value) void room.stop()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== '.' || !(event.metaKey || event.ctrlKey)) return
  if (event.altKey || event.shiftKey || modalLayerCount() > 0) return
  if (!room.running.value) return
  event.preventDefault()
  stop()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="group-page" data-group-page>
    <EmptyState
      v-if="room.gone.value"
      title="没有找到这个群"
      description="它可能已被删除。"
    >
      <Button size="sm" @click="backHome">回到群聊首页</Button>
    </EmptyState>
    <Notice
      v-else-if="room.loadError.value"
      tone="error"
      title="群没有打开"
      :description="room.loadError.value"
    />
    <template v-else-if="group">
      <main class="main">
        <header class="head">
          <h1 class="title">{{ group.title }}</h1>
          <span class="muted">{{ group.members.length }} 人</span>
          <span class="tag" data-collaboration>{{
            collaborationLabel(group.settings)
          }}</span>
          <span class="right">
            <span class="spend" data-spend title="只显示，不设上限">{{
              spendLabel(room.turn.value)
            }}</span>
            <Button
              size="sm"
              class="stop"
              :disabled="!room.running.value"
              @click="stop"
              >停止 <Kbd class="key">⌘.</Kbd></Button
            >
            <IconButton
              label="群设置"
              data-open-settings
              @click="openGroupSettings"
            >
              <Settings2 :size="16" />
            </IconButton>
          </span>
        </header>
        <div ref="scroller" class="scroll" @scroll.passive="onScroll">
          <GroupConversation
            :messages="room.messages.value"
            :members="room.members.value"
            :contacts="directory.contacts.value"
            :finished="room.finished.value"
            :asks="room.asks.value"
            @process="openProcess"
            @answer="room.answer"
            @cancel-ask="room.cancelAsk"
            @confirm-task="room.confirmTask($event.taskId, $event.approve)"
            @open-settings="openSettings"
          />
          <p
            v-if="
              room.loaded.value &&
              !room.messages.value.length &&
              !room.asks.value.length
            "
            class="empty"
          >
            群里还没有消息。发给所有人，让有关的成员举手；或者 @ 一位成员点名。
          </p>
        </div>
        <div class="dock">
          <GroupLiveBar
            :turn="room.liveTurn.value"
            :names="names"
            :tasks="room.taskMembers.value"
            :speeches="speeches"
            :ended-at="endedAt"
          />
          <GroupComposer
            :members="room.members.value"
            :contacts="directory.contacts.value"
            :moderator="group.moderator"
            :submit="room.send"
          />
        </div>
      </main>
      <GroupMembers
        class="side"
        :members="room.members.value"
        :contacts="directory.contacts.value"
        :moderator="group.moderator"
        :statuses="room.statuses.value"
        :tools="room.tools.value"
        :pending="room.pending.value"
        :tasks="room.taskMembers.value"
        :addable="addable"
        @invite="room.invite"
        @open="openProfile"
      />
    </template>
  </div>
</template>

<style scoped>
.group-page {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) 232px;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.group-page > :deep(.ds-empty-state),
.group-page > :deep(.ds-notice) {
  grid-column: 1 / -1;
  align-self: start;
  margin: var(--space-6);
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2-5);
  min-height: 50px;
  padding: var(--space-2-5) var(--space-5);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.title {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
}

.muted {
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.tag {
  padding: 0 var(--space-2-5);
  border-radius: var(--r-full);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.spend {
  padding: 0 var(--space-2-5);
  border-radius: var(--r-full);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.stop:not(:disabled) {
  color: rgb(var(--error));
}

.key {
  margin-left: var(--space-1);
  color: inherit;
  opacity: 0.7;
}

.scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-3);
  overflow-y: auto;
}

.empty {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.dock {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-6) var(--space-3-5);
}

.side {
  min-height: 0;
}
</style>
