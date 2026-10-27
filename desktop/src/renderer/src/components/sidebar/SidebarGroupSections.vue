<script setup lang="ts">
/**
 * Group's sections of the sidebar (GRP-05, 预览 A): 群聊, then 联系人. A row
 * is an avatar, a name and one line under it — a group's member count and
 * when it last spoke, or who speaks there now (「架构师 发言中…」, 「架构师
 * 等 2 人发言中…」) or waits (「排队：研究员」) while a turn runs (GRP-13,
 * groupLive.ts); a contact's intro (「外部」 for Claude Code and Codex
 * without one). A contact opens its profile, a group its page. The row on
 * screen is marked: the contact of the profile, editor or single chat
 * open, or the group open (its settings and a member's work too). The +
 * of 联系人 opens the contact editor; the + of 群聊 opens 新建群聊
 * (GRP-08). Folding a section lasts while the
 * window is open. Loaded with the Group mode only (SidebarRoot), so the
 * entry bundle stays as it was.
 */
import { Users } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Contact } from '@emperor/core/api'
import { useSession } from '../../composables/useSession'
import { sidebarRelativeTime } from '../../runtime/sidebarModel'
import {
  useContactDirectory,
  type GroupSummary,
} from '../contacts/contactDirectory'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { DsPlus } from '../icons/ds'
import Avatar from '../ui/Avatar.vue'
import IconButton from '../ui/IconButton.vue'
import {
  groupLiveLine,
  useGroupLive,
  type GroupLiveLine,
} from '../groups/groupLive'
import { openNewGroupDialog } from '../groups/newGroupDialog'
import SidebarSectionHeader from './SidebarSectionHeader.vue'

const route = useRoute()
const router = useRouter()
const directory = useContactDirectory()
const live = useGroupLive()
const { sessions } = useSession()

const groupsFolded = ref(false)
const contactsFolded = ref(false)

function param(name: string): string {
  const raw = route.params[name]
  return typeof raw === 'string' ? raw : ''
}

/** The session the chat route shows, if the list knows it. */
const routedSession = computed(() => {
  if (route.name !== 'chat' && route.name !== 'trajectory') return undefined
  const id = param('sessionId')
  return id ? sessions.value.find((session) => session.id === id) : undefined
})

const activeContactId = computed(() => {
  if (route.name === 'contact' || route.name === 'contact-edit')
    return param('id')
  const session = routedSession.value
  return session?.surface === 'contact' ? (session.contact_id ?? '') : ''
})

const activeGroupId = computed(() => {
  if (route.name === 'group' || route.name === 'group-settings')
    return param('groupId')
  const session = routedSession.value
  if (session?.surface === 'group') return session.group_id || session.id
  // A member's work (「过程 ›」, GRP-08) is its group's.
  return session?.surface === 'group_member' ? (session.group_id ?? '') : ''
})

function contactLine(contact: Contact): string {
  if (contact.intro.trim()) return contact.intro
  return contact.kind === 'external' ? '外部' : '还没有简介'
}

function memberName(id: string): string {
  return directory.find(id)?.name ?? '已删除的联系人'
}

/** Who speaks or waits now; else the member count and the last message. */
function groupLine(group: GroupSummary): {
  text: string
  tone?: GroupLiveLine['tone']
} {
  const now = groupLiveLine(live.value[group.id], memberName)
  if (now) return now
  const when = group.lastMessageAt
    ? sidebarRelativeTime(new Date(group.lastMessageAt).toISOString())
    : '还没有消息'
  return { text: `${group.memberCount} 人 · ${when}` }
}

const groupLines = computed(
  () =>
    new Map(
      directory.groups.value.map((group) => [group.id, groupLine(group)]),
    ),
)

function openContact(id: string) {
  void router.push({ name: 'contact', params: { id } }).catch(() => undefined)
}

function openGroup(groupId: string) {
  void router
    .push({ name: 'group', params: { groupId } })
    .catch(() => undefined)
}

function newContact() {
  void router.push({ name: 'contact-new' }).catch(() => undefined)
}
</script>

<template>
  <section class="section" aria-label="群聊" data-sidebar-section="groups">
    <SidebarSectionHeader v-model:collapsed="groupsFolded" label="群聊">
      <IconButton
        class="head-button"
        label="新建群聊"
        size="xs"
        @click="openNewGroupDialog"
      >
        <DsPlus :size="16" />
      </IconButton>
    </SidebarSectionHeader>
    <template v-if="!groupsFolded">
      <div
        v-for="group in directory.groups.value"
        :key="group.id"
        class="row"
        role="button"
        tabindex="0"
        :data-row="group.id"
        :data-active="group.id === activeGroupId || undefined"
        :aria-current="group.id === activeGroupId ? 'page' : undefined"
        :title="group.title"
        @click="openGroup(group.id)"
        @keydown.enter.self="openGroup(group.id)"
        @keydown.space.self.prevent="openGroup(group.id)"
      >
        <span class="group-tile" aria-hidden="true">
          <Users :size="14" />
        </span>
        <span class="two">
          <span class="name">{{ group.title }}</span>
          <span
            class="line"
            :data-tone="groupLines.get(group.id)?.tone"
            data-group-line
            >{{ groupLines.get(group.id)?.text }}</span
          >
        </span>
      </div>
      <div
        v-if="directory.loaded.value && !directory.groups.value.length"
        class="empty"
      >
        还没有群聊：在群聊首页 @ 几位联系人就会建一个
      </div>
    </template>
  </section>

  <section class="section" aria-label="联系人" data-sidebar-section="contacts">
    <SidebarSectionHeader v-model:collapsed="contactsFolded" label="联系人">
      <IconButton
        class="head-button"
        label="新建联系人"
        size="xs"
        @click="newContact"
      >
        <DsPlus :size="16" />
      </IconButton>
    </SidebarSectionHeader>
    <template v-if="!contactsFolded">
      <div
        v-for="contact in directory.contacts.value"
        :key="contact.id"
        class="row"
        role="button"
        tabindex="0"
        :data-row="contact.id"
        :data-active="contact.id === activeContactId || undefined"
        :aria-current="contact.id === activeContactId ? 'page' : undefined"
        :title="contact.name"
        @click="openContact(contact.id)"
        @keydown.enter.self="openContact(contact.id)"
        @keydown.space.self.prevent="openContact(contact.id)"
      >
        <Avatar
          v-bind="contactAvatarProps(contact.avatar, contact.name)"
          :size="24"
        />
        <span class="two">
          <span class="name">{{ contact.name }}</span>
          <span class="line">{{ contactLine(contact) }}</span>
        </span>
      </div>
      <div
        v-if="directory.loaded.value && directory.failed.value"
        class="empty"
        role="status"
      >
        联系人读取失败：{{ directory.failed.value }}
      </div>
    </template>
  </section>
</template>

<style scoped>
.section + .section {
  margin-top: var(--space-2);
}

.head-button {
  color: rgb(var(--text-2));
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: calc(var(--space-8) + var(--space-2));
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-row);
  color: rgb(var(--text-1));
  cursor: pointer;
  user-select: none;
  outline: none;
  animation: ds-fade-in var(--motion-base) var(--ease-standard);
}

.row:hover {
  background: var(--surface-hover);
}

.row[data-active] {
  background: rgb(var(--surface-selected));
}

.row:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.group-tile {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: var(--space-6);
  height: var(--space-6);
  border-radius: var(--r-full);
  background: var(--surface-hover);
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-2));
}

.two {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.name,
.line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.row[data-active] .name {
  font-weight: var(--weight-medium);
}

.line {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.line[data-tone='busy'] {
  color: rgb(var(--info));
}

.empty {
  padding: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}
</style>
