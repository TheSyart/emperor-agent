<script setup lang="ts">
/**
 * GroupMembers — the group page's right column (GRP-08, 预览 B 第 3 步):
 * 「成员 N」 and 「邀请」, then one row per member — avatar with a status
 * dot, name and status (空闲, 发言中, 执行中, 排队, 等你回答, 出错; 主持人 and
 * external members say so while idle) — and at the bottom what 不设本轮额度
 * means. A status change is read out politely: the member and the status,
 * never what was said. Past 8 members the list scrolls. A row opens the
 * contact's profile; a deleted contact is greyed out.
 *
 * Props: members; contacts (avatars); moderator; statuses
 * (group_member_status); tools (running a tool now); pending (a question
 * or approval waiting, per member); tasks (members queued for a task);
 * addable (contacts who can be invited).
 * Emits: invite(contactId), open(contactId).
 */
import { computed, ref, watch } from 'vue'
import type { Contact } from '@emperor/core/api'
import type { ControlInteraction } from '../../types'
import { contactAvatarProps } from '../contacts/contactAvatar'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import {
  memberStatusLine,
  type GroupMemberView,
  type MemberLiveStatus,
  type MemberTone,
} from './groupModel'
import { GROUP_MEMBER_LIMIT } from './newGroupModel'

const props = withDefaults(
  defineProps<{
    members: readonly GroupMemberView[]
    contacts: readonly Contact[]
    moderator: string | null
    statuses: Readonly<Record<string, MemberLiveStatus>>
    tools: Readonly<Record<string, boolean>>
    pending: Readonly<
      Record<string, Pick<ControlInteraction, 'id' | 'kind' | 'status'> | null>
    >
    tasks: readonly string[]
    addable?: readonly Contact[]
  }>(),
  { addable: () => [] },
)
const emit = defineEmits<{
  invite: [contactId: string]
  open: [contactId: string]
}>()

/** Past this many members the list scrolls (卡片：成员 > 8 时成员栏滚动). */
const SCROLL_AFTER = 8

const rows = computed(() =>
  props.members.map((member) => {
    const contact = props.contacts.find((item) => item.id === member.id)
    const line = memberStatusLine(member, {
      moderator: props.moderator,
      status: props.statuses[member.id],
      tool: props.tools[member.id] === true,
      pending: props.pending[member.id] ?? null,
      task: props.tasks.includes(member.id),
    })
    return {
      member,
      line,
      avatar: contact
        ? contactAvatarProps(contact.avatar, contact.name)
        : { kind: 'initials' as const, label: member.name },
    }
  }),
)

const announcement = ref('')
watch(
  () =>
    rows.value.map(
      (row) => [row.member.id, row.member.name, row.line.text] as const,
    ),
  (next, previous) => {
    const before = new Map((previous ?? []).map(([id, , text]) => [id, text]))
    const changed = next
      .filter(([id, , text]) => before.has(id) && before.get(id) !== text)
      .map(([, name, text]) => `${name} ${text}`)
    if (changed.length) announcement.value = changed.join('；')
  },
)

const inviteAnchor = ref<HTMLElement | null>(null)
const inviting = ref(false)
const full = computed(() => props.members.length >= GROUP_MEMBER_LIMIT)

function openInvite(event: MouseEvent): void {
  inviteAnchor.value = event.currentTarget as HTMLElement
  inviting.value = true
}

const TONE_DOT: Partial<Record<MemberTone, true>> = {
  busy: true,
  ask: true,
  queued: true,
  error: true,
}
</script>

<template>
  <aside class="members" aria-label="成员" data-group-members>
    <div class="head">
      <h2 class="title" data-member-count>成员 {{ members.length }}</h2>
      <Button
        size="sm"
        data-invite
        :disabled="full || !addable.length"
        :title="full ? `一个群最多 ${GROUP_MEMBER_LIMIT} 位成员` : undefined"
        @click="openInvite"
        >+ 邀请</Button
      >
    </div>
    <Menu
      v-model:open="inviting"
      :anchor="inviteAnchor"
      placement="bottom"
      label="邀请进群"
      dense
    >
      <MenuItem
        v-for="contact in addable"
        :key="contact.id"
        :description="contact.intro || undefined"
        @select="emit('invite', contact.id)"
      >
        <template #icon>
          <Avatar
            v-bind="contactAvatarProps(contact.avatar, contact.name)"
            :size="16"
          />
        </template>
        {{ contact.name }}
      </MenuItem>
    </Menu>
    <div
      class="list"
      data-member-list
      :data-scroll="members.length > SCROLL_AFTER ? 'true' : undefined"
    >
      <div
        v-for="row in rows"
        :key="row.member.id"
        class="row"
        role="button"
        tabindex="0"
        :data-member-row="row.member.id"
        :data-missing="row.member.missing || undefined"
        :title="row.member.intro || row.member.name"
        @click="emit('open', row.member.id)"
        @keydown.enter.self="emit('open', row.member.id)"
        @keydown.space.self.prevent="emit('open', row.member.id)"
      >
        <span class="face" :data-tone="row.line.tone">
          <Avatar v-bind="row.avatar" :size="28" />
          <span v-if="TONE_DOT[row.line.tone]" class="dot" aria-hidden="true" />
        </span>
        <span class="two">
          <span class="name">{{
            row.member.missing ? '已删除的联系人' : row.member.name
          }}</span>
          <span class="status" data-status :data-tone="row.line.tone">{{
            row.line.text
          }}</span>
        </span>
      </div>
    </div>
    <p class="notice">
      <b>不设本轮额度</b>
      <span
        >不限发言次数和费用，只显示花了多少。停不下来时：点「停止」，或者等主持人发现「来回没有新进展」后收尾。</span
      >
    </p>
    <div class="live" aria-live="polite" data-member-announcer>
      {{ announcement }}
    </div>
  </aside>
</template>

<style scoped>
.members {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-height: 0;
  padding: var(--space-3);
  box-shadow: inset 0.5px 0 0 var(--hairline);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-1);
  margin-bottom: var(--space-1-5);
}

.title {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
}

.list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-0-5);
  min-height: 0;
  overflow-y: auto;
}

.row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-1);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.row:hover {
  background: var(--surface-hover);
}

.row:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.row[data-missing] .face {
  filter: grayscale(1);
  opacity: 0.55;
}

.face {
  position: relative;
  display: inline-flex;
  border-radius: var(--r-full);
}

.face[data-tone='busy'] {
  box-shadow:
    0 0 0 2px rgb(var(--surface-base)),
    0 0 0 3.5px rgb(var(--info));
  animation: speaking 1.6s ease-in-out infinite;
}

@keyframes speaking {
  50% {
    box-shadow:
      0 0 0 2px rgb(var(--surface-base)),
      0 0 0 4.5px rgb(var(--info) / 0.45);
  }
}

.dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: var(--r-full);
  box-shadow: 0 0 0 2px rgb(var(--surface-base));
}

.face[data-tone='busy'] .dot {
  background: rgb(var(--info));
}

.face[data-tone='ask'] .dot {
  background: rgb(var(--attention));
}

.face[data-tone='queued'] .dot {
  background: rgb(var(--text-4));
}

.face[data-tone='error'] .dot {
  background: rgb(var(--error));
}

.two {
  display: grid;
  min-width: 0;
}

.name {
  overflow: hidden;
  font-size: var(--fs-xs);
  line-height: var(--lh-xxs);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status[data-tone='busy'] {
  color: rgb(var(--info));
}

.status[data-tone='ask'] {
  color: rgb(var(--attention));
}

.status[data-tone='error'] {
  color: rgb(var(--error));
}

.notice {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: var(--space-2-5);
  border-radius: var(--r-sm);
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-2));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.notice b {
  color: rgb(var(--text-1));
  font-weight: var(--weight-medium);
}

.live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
