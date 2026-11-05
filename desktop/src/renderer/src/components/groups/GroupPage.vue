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
import { ROLE_CREATOR_CONTACT_ID } from '@emperor/core/runtime-contract'
import { Settings2, Users } from 'lucide-vue-next'
import { openLink, revealReference } from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import type { MarkdownReferenceRequest } from '../../composables/useMarkdownLinks'
import { useContactDirectory } from '../contacts/contactDirectory'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import type { SettingsModalSection } from '../settings/settingsSections'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import IconButton from '../ui/IconButton.vue'
import Kbd from '../ui/Kbd.vue'
import Notice from '../ui/Notice.vue'
import { modalLayerCount } from '../ui/modalStack'
import GroupArtifactPreview from './GroupArtifactPreview.vue'
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
import { useSkinExempt } from '../../skin/skinState'

/** BRD-05 (D8): a skin may not reach this zone. */
const exempt = useSkinExempt()

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
    (contact) =>
      contact.id !== ROLE_CREATOR_CONTACT_ID &&
      !room.members.value.some((member) => member.id === contact.id),
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
  () => [
    room.messages.value.length,
    room.asks.value.length,
    room.streams.value.length,
    room.streams.value.reduce((sum, stream) => sum + stream.text.length, 0),
  ],
  async () => {
    if (!pinned) return
    await nextTick()
    const element = scroller.value
    if (element) element.scrollTop = element.scrollHeight
  },
)
watch(groupId, () => (pinned = true))

// ── actions ─────────────────────────────────────────────────────────────
const membersOpen = ref(false)
const membersPanel = ref<InstanceType<typeof GroupMembers> | null>(null)
watch(groupId, () => (membersOpen.value = false))

function openProcess(contactId: string): void {
  if (!room.members.value.some((member) => member.id === contactId)) return
  membersPanel.value?.openMember(contactId)
  membersOpen.value = true
}

const artifactPreview = ref<{
  ref: string
  name: string
  mimeType: string
} | null>(null)
const artifactPreviewOpen = ref(false)
function previewArtifact(input: {
  ref: string
  name: string
  mimeType: string
}): void {
  artifactPreview.value = input
  artifactPreviewOpen.value = true
}
async function getArtifact(ref: string): Promise<void> {
  const owner = groupId.value
  try {
    const reference = await core('references.resolve', {
      sessionId: owner,
      sourceMessageId: 'group-artifact-get',
      href: ref,
      label: ref,
    })
    if (
      reference.available &&
      reference.id &&
      reference.actions.includes('reveal')
    )
      await revealReference({ sessionId: owner, referenceId: reference.id })
  } catch {
    // A stale public reference stays inert; the conversation remains usable.
  }
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
  void router.push({ name: 'groups' }).catch(() => undefined)
}

function stop(): void {
  if (room.running.value) void room.stop()
}

// GroupMarkdown uses the same delegated links as Chat/Build. A group is a
// readable Core session of its own, so resolve against that session rather
// than borrowing a member's workspace. Group has no Files pane: open sites
// through the normal browser route and reveal usable files in Finder.
async function resolveMarkdownReference(event: Event): Promise<void> {
  const detail = (event as CustomEvent<MarkdownReferenceRequest>).detail
  const owner = groupId.value
  if (!detail?.href || !owner || !group.value) return
  try {
    const reference = await core('references.resolve', {
      sessionId: owner,
      sourceMessageId: detail.sourceMessageId || 'markdown',
      href: detail.href,
      label: detail.label || detail.href,
    })
    if (owner !== groupId.value || !group.value || !reference.available) return
    if (reference.kind === 'web') {
      if (reference.actions.includes('open_external'))
        await openLink(reference.tooltip)
      return
    }
    if (reference.actions.includes('reveal'))
      await revealReference({ sessionId: owner, referenceId: reference.id })
  } catch {
    // An unavailable or stale reference stays inert; the room remains usable.
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && membersOpen.value && !modalLayerCount()) {
    membersOpen.value = false
    return
  }
  if (event.key !== '.' || !(event.metaKey || event.ctrlKey)) return
  if (event.altKey || event.shiftKey || modalLayerCount() > 0) return
  if (!room.running.value) return
  event.preventDefault()
  stop()
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('emperor:resolve-reference', resolveMarkdownReference)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener(
    'emperor:resolve-reference',
    resolveMarkdownReference,
  )
})
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
          <IconButton
            class="members-toggle"
            label="成员与执行详情"
            data-open-members
            @click="membersOpen = true"
          >
            <Users :size="16" />
          </IconButton>
          <span class="right">
            <span
              class="spend"
              data-spend
              title="只显示，不设上限"
              :style="exempt"
              >{{ spendLabel(room.turn.value) }}</span
            >
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
            :group-id="groupId"
            :artifacts="room.artifacts.value"
            :members="room.members.value"
            :contacts="directory.contacts.value"
            :asks="room.asks.value"
            :streams="room.streams.value"
            @process="openProcess"
            @answer="room.answer"
            @cancel-ask="room.cancelAsk"
            @preview-artifact="previewArtifact"
            @get-artifact="getArtifact"
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
      <Button
        v-if="membersOpen"
        class="member-scrim"
        type="button"
        aria-label="关闭成员与执行详情"
        data-close-members
        @click="membersOpen = false"
      />
      <GroupMembers
        ref="membersPanel"
        class="side"
        :class="{ open: membersOpen }"
        :members="room.members.value"
        :contacts="directory.contacts.value"
        :moderator="group.moderator"
        :statuses="room.statuses.value"
        :tools="room.tools.value"
        :pending="room.pending.value"
        :tasks="room.taskMembers.value"
        :task-list="room.tasks.value"
        :messages="room.messages.value"
        :group-title="group.title"
        :addable="addable"
        @invite="room.invite"
      />
      <GroupArtifactPreview
        v-model:open="artifactPreviewOpen"
        :group-id="groupId"
        :artifact="artifactPreview"
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
  --chat-content-width: 748px;

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
  padding: var(--space-4) var(--space-8) var(--space-3);
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
  padding: 0 var(--space-8) var(--space-3-5);
}

.dock > * {
  width: 100%;
  max-width: var(--chat-content-width);
  margin-inline: auto;
}

@media (max-width: 600px) {
  .scroll {
    padding-inline: var(--space-4);
  }

  .dock {
    padding-inline: var(--space-4);
  }
}

.side {
  min-height: 0;
}

.members-toggle,
.member-scrim {
  display: none;
}

@media (max-width: 1080px) {
  .group-page {
    grid-template-columns: minmax(0, 1fr);
  }

  .members-toggle {
    display: inline-flex;
  }

  .member-scrim {
    position: fixed;
    z-index: var(--z-overlay);
    inset: 0;
    display: block;
    height: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: rgb(var(--overlay-scrim, 0 0 0) / 0.24);
    cursor: default;
  }

  .side {
    position: fixed;
    z-index: var(--z-drawer);
    top: 0;
    right: 0;
    bottom: 0;
    display: block;
    width: min(340px, 88vw);
    background: rgb(var(--surface-base));
    box-shadow: -12px 0 32px rgb(var(--overlay-scrim, 0 0 0) / 0.14);
    transform: translateX(102%);
    transition: transform var(--motion-base) var(--ease-standard);
  }

  .side.open {
    transform: translateX(0);
  }
}
</style>
