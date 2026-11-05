<script setup lang="ts">
/**
 * GroupMembers — the group page's right column (GRP-08, 预览 B 第 3 步):
 * 「成员 N」 and 「邀请」, then one row per member — avatar with a status
 * dot, name and status (空闲, 发言中, 执行中, 排队, 等你回答, 出错; 主持人 and
 * external members say so while idle) — and at the bottom what 不设本轮额度
 * progress. A status change is read out politely: the member and the status,
 * never what was said. Past 8 members the list scrolls. A row opens the
 * read-only activity from this group; a deleted contact is greyed out.
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
  independentProgress,
  memberStatusLine,
  TASK_STATE_LABELS,
  type GroupHistoryMessage,
  type GroupMemberView,
  type GroupTask,
  type MemberLiveStatus,
  type MemberTone,
} from './groupModel'
import { GROUP_MEMBER_LIMIT } from './newGroupModel'
import GroupMemberActivity from './GroupMemberActivity.vue'

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
    taskList?: readonly GroupTask[]
    messages?: readonly GroupHistoryMessage[]
    groupTitle?: string
    addable?: readonly Contact[]
  }>(),
  { addable: () => [], taskList: () => [], messages: () => [], groupTitle: '' },
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

const selected = ref<string | null>(null)
const selectedMember = computed(
  () => props.members.find((member) => member.id === selected.value) ?? null,
)
const independent = computed(() => independentProgress(props.messages))
watch(
  () => props.members.map((member) => member.id).join('\n'),
  () => {
    if (selected.value && !selectedMember.value) selected.value = null
  },
)
function openMember(contactId: string): void {
  selected.value = contactId
  emit('open', contactId)
}

defineExpose({ openMember })
function taskState(task: GroupTask): string {
  return TASK_STATE_LABELS[task.state]
}
function taskSteps(
  task: GroupTask,
): Array<{ text: string; tone: 'done' | 'current' }> {
  if (task.state === 'queued') return [{ text: '等待接单', tone: 'current' }]
  if (task.state === 'failed')
    return [
      {
        text: `没有完成 · ${task.problem?.reason ?? '执行失败'}`,
        tone: 'current',
      },
    ]
  if (task.state === 'cancelled') return [{ text: '已取消', tone: 'current' }]
  const steps: Array<{ text: string; tone: 'done' | 'current' }> = [
    { text: '已接单', tone: 'done' },
  ]
  if (task.state === 'running')
    steps.push({ text: '执行与检查中', tone: 'current' })
  else {
    steps.push({ text: '执行与检查已完成', tone: 'done' })
    steps.push({
      text: '公开成果已发布',
      tone: task.state === 'done' ? 'done' : 'current',
    })
  }
  return steps
}

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
  <aside class="members" aria-label="成员与协作进展" data-group-members>
    <GroupMemberActivity
      v-if="selectedMember"
      :member="selectedMember"
      :contact="contacts.find((contact) => contact.id === selectedMember!.id)"
      :group-title="groupTitle"
      @back="selected = null"
    />
    <template v-else>
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
          <template #icon
            ><Avatar
              v-bind="contactAvatarProps(contact.avatar, contact.name)"
              :size="16"
          /></template>
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
          @click="openMember(row.member.id)"
          @keydown.enter.self="openMember(row.member.id)"
          @keydown.space.self.prevent="openMember(row.member.id)"
        >
          <span class="face" :data-tone="row.line.tone"
            ><Avatar v-bind="row.avatar" :size="28" /><span
              v-if="TONE_DOT[row.line.tone]"
              class="dot"
              aria-hidden="true"
          /></span>
          <span class="two"
            ><span class="name">{{
              row.member.missing ? '已删除的联系人' : row.member.name
            }}</span
            ><span class="status" data-status :data-tone="row.line.tone">{{
              row.line.text
            }}</span></span
          >
        </div>
      </div>
      <section
        v-if="taskList.length"
        class="progress-section"
        data-task-progress
      >
        <div class="section-label">任务进度</div>
        <div
          v-for="task in taskList"
          :key="task.taskId"
          class="task-progress"
          :data-task-id="task.taskId"
        >
          <div class="task-title">
            <b>{{ task.title }}</b
            ><span>{{ taskState(task) }}</span>
          </div>
          <p class="owner">
            {{
              members.find((member) => member.id === task.to)?.name ?? task.to
            }}负责
          </p>
          <ol class="steps">
            <li
              v-for="step in taskSteps(task)"
              :key="step.text"
              :data-tone="step.tone"
            >
              {{ step.text }}
            </li>
          </ol>
          <p v-if="task.state === 'done' && task.checks?.length" class="checks">
            {{ task.checks.length }} 项检查通过 · 已自动完成
          </p>
        </div>
      </section>
      <section
        v-for="batch in independent"
        :key="batch.batchId"
        class="progress-section"
        data-independent-progress
      >
        <div class="section-label">
          发言进度
          <span
            >{{ batch.answers.length }}/{{ batch.members.length }} 已答</span
          >
        </div>
        <p class="independent-status">
          {{
            batch.revealed
              ? '全部答完，已一起显示'
              : '答完后一起显示，答案不会提前出现'
          }}
        </p>
      </section>
    </template>
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
  flex: 0 1 auto;
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

.progress-section {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-1) 0;
  box-shadow: inset 0 0.5px 0 var(--hairline);
}
.section-label {
  display: flex;
  justify-content: space-between;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.task-progress {
  display: grid;
  gap: var(--space-1-5);
}
.task-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.task-title b {
  min-width: 0;
  font-size: var(--fs-xs);
  font-weight: var(--weight-medium);
}
.task-title span {
  margin-left: auto;
  flex: none;
  color: rgb(var(--info));
  font-size: var(--fs-xxs);
}
.owner,
.checks,
.independent-status {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.steps {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  position: relative;
  padding-left: var(--space-3);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}
.steps li:before {
  content: '';
  position: absolute;
  left: 2px;
  top: var(--space-1-5);
  width: 5px;
  height: 5px;
  border-radius: var(--r-full);
  background: rgb(var(--text-4));
}
.steps li[data-tone='done']:before {
  background: rgb(var(--ok));
}
.steps li[data-tone='current'] {
  color: rgb(var(--text-1));
}
.steps li[data-tone='current']:before {
  background: rgb(var(--info));
}
.checks {
  color: rgb(var(--ok));
}
.independent-status {
  line-height: var(--lh-s);
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
