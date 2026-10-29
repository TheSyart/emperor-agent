<script setup lang="ts">
/**
 * Group's section of the sidebar (GRP-05, GRP-21): 群聊. A row is a tile,
 * a name and one line under it — the member count and when it last spoke,
 * or who speaks there now (「架构师 发言中…」, 「架构师 等 2 人发言中…」)
 * or waits (「排队：研究员」) while a turn runs (GRP-13, groupLive.ts).
 * The + opens 新建群聊 (GRP-08); the group on screen is marked (its
 * settings and a member's work too). Folding lasts while the window is
 * open. Contacts live on their own page (ContactsPage) since GRP-21;
 * SidebarRoot loads this only in Group mode, so the entry bundle stays as
 * it was.
 */
import { Users } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '../../composables/useSession'
import { sidebarRelativeTime } from '../../runtime/sidebarModel'
import {
  useContactDirectory,
  type GroupSummary,
} from '../contacts/contactDirectory'
import { DsPlus } from '../icons/ds'
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

const activeGroupId = computed(() => {
  if (route.name === 'group' || route.name === 'group-settings')
    return param('groupId')
  const session = routedSession.value
  if (session?.surface === 'group') return session.group_id || session.id
  // A member's work (「过程 ›」, GRP-08) is its group's.
  return session?.surface === 'group_member' ? (session.group_id ?? '') : ''
})

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

function openGroup(groupId: string) {
  void router
    .push({ name: 'group', params: { groupId } })
    .catch(() => undefined)
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
