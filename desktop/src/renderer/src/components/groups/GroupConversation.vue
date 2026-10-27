<script setup lang="ts">
/**
 * GroupConversation — the group's message flow (GRP-08, 预览 B 第 3 步,
 * docs/design/agent-contacts.md § 群聊页), oldest first:
 * - the user: a warm bubble on the right, its audience above it
 *   (「→ 所有人」, 「→ @架构师」, 「🔒 私信 → 写作者」);
 * - say: avatar, name, role and audience, what was said (Markdown, @
 *   marked), 「过程 ›」 at the top right for the member's own work;
 * - independent answers: one card, side by side once all are revealed,
 *   until then 「N/3 已答，答完一起显示」;
 * - private: a violet line and 「🔒 私信 → X · 其他成员看不到，你能看到」;
 * - task: the task card (交付, 依据, 权限, state; 同意 / 不同意 when a code
 *   change for Claude Code or Codex waits for the user);
 * - result: what was handed back, with the result card of an external run;
 * - summary: the moderator's conclusion on a light gold ground;
 * - system: one centred line (a 「设置 › …」 in it becomes a button);
 * - pass: one faint line, 「架构师 没有补充」.
 * Members' tool steps never show here. A message past 12 lines folds. A
 * member's question or approval waiting in its own session shows as its
 * message where it was asked (D29). A deleted contact is greyed out.
 *
 * Props: messages; members; contacts; finished (members done speaking in
 * this turn, for an independent card's progress); asks.
 * Emits: process(contactId), answer, cancelAsk, confirmTask, openSettings.
 */
import { computed, ref } from 'vue'
import type { Contact } from '@emperor/core/api'
import type { ControlInteraction } from '../../types'
import { contactAvatarProps } from '../contacts/contactAvatar'
import {
  SETTINGS_SECTIONS,
  type SettingsModalSection,
} from '../settings/settingsSections'
import Avatar from '../ui/Avatar.vue'
import LinkButton from '../ui/LinkButton.vue'
import GroupAskMessage from './GroupAskMessage.vue'
import GroupMarkdown from './GroupMarkdown.vue'
import GroupResultCard from './GroupResultCard.vue'
import GroupTaskCard from './GroupTaskCard.vue'
import { mentionedContacts } from './groupHomeModel'
import {
  isLongMessage,
  mentionSegments,
  privateLabel,
  timelineRows,
  type GroupAsk,
  type GroupHistoryMessage,
  type GroupMemberView,
  type IndependentBatch,
  type TimelineRow,
} from './groupModel'

const props = defineProps<{
  messages: readonly GroupHistoryMessage[]
  members: readonly GroupMemberView[]
  contacts: readonly Contact[]
  finished: readonly string[]
  asks: readonly GroupAsk[]
}>()
const emit = defineEmits<{
  process: [contactId: string]
  answer: [
    payload: {
      contactId: string
      interaction: ControlInteraction
      answers: Record<string, unknown>
      reply: string
    },
  ]
  cancelAsk: [payload: { contactId: string; interaction: ControlInteraction }]
  confirmTask: [payload: { taskId: string; approve: boolean }]
  openSettings: [section: SettingsModalSection]
}>()

interface Person {
  name: string
  intro: string
  avatar:
    ReturnType<typeof contactAvatarProps> | { kind: 'initials'; label: string }
  missing: boolean
  sessionId: string | null
}

function person(id: string): Person {
  const member = props.members.find((item) => item.id === id)
  const contact = props.contacts.find((item) => item.id === id)
  if (!contact && (!member || member.missing))
    return {
      name: '已删除的联系人',
      intro: '',
      avatar: { kind: 'initials', label: '?' },
      missing: true,
      sessionId: null,
    }
  const name = contact?.name ?? member?.name ?? id
  return {
    name,
    intro: contact?.intro ?? member?.intro ?? '',
    avatar: contact
      ? contactAvatarProps(contact.avatar, contact.name)
      : { kind: 'initials', label: name },
    missing: false,
    sessionId: member?.memberSessionId ?? null,
  }
}

const names = computed(() => [
  ...new Set([
    ...props.members.map((member) => member.name),
    ...props.contacts.map((contact) => contact.name),
  ]),
])

function nameOf(id: string): string {
  return person(id).name
}

/** Who a message is for, above it. */
function audience(message: GroupHistoryMessage): string {
  if (message.audience.kind === 'private')
    return `🔒 私信 → ${nameOf(message.audience.to)}`
  const asked = message.ask.map((id) => `@${nameOf(id)}`).join(' ')
  if (message.answerMode === 'independent')
    return `→ ${
      mentionedContacts(message.text, props.members).length && asked
        ? asked
        : '所有人'
    } · 各自独立回答`
  if (message.audience.kind === 'members' && asked) return `→ ${asked}`
  return '→ 所有人'
}

function taskTitle(id: string | undefined): string {
  if (!id) return ''
  return props.messages.find((message) => message.id === id)?.task?.title ?? ''
}

/** 「设置 › 子智能体」 in a system line, as the section it opens. */
function settingsLink(
  text: string,
): { section: SettingsModalSection; label: string } | null {
  const match = /「设置 › ([^」›]+)/.exec(text)
  const label = match?.[1]?.trim()
  const section = SETTINGS_SECTIONS.find((item) => item.label === label)
  return section ? { section: section.key, label: section.label } : null
}

const WARN =
  /失败|上限|没有登录|还没有登录|不兼容|不可用|已停下|暂停|没有送达|出错/

// ── folding ─────────────────────────────────────────────────────────────
const unfolded = ref(new Set<string>())
function folded(message: GroupHistoryMessage): boolean {
  return isLongMessage(message.text) && !unfolded.value.has(message.id)
}
function toggleFold(id: string): void {
  const next = new Set(unfolded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  unfolded.value = next
}

// ── the flow with the asks in it ────────────────────────────────────────
type Item =
  | { key: string; row: TimelineRow; ask?: undefined }
  | { key: string; ask: GroupAsk; row?: undefined }

function rowAt(row: TimelineRow, previous: number): number {
  if (row.kind !== 'independent') return row.message.at
  return row.batch.answers[0]?.at ?? previous
}

const items = computed<Item[]>(() => {
  const asks = [...props.asks].sort(
    (a, b) =>
      (a.interaction.created_at ?? Number.MAX_SAFE_INTEGER) -
      (b.interaction.created_at ?? Number.MAX_SAFE_INTEGER),
  )
  const list: Item[] = []
  let at = 0
  for (const row of timelineRows(props.messages)) {
    at = rowAt(row, at)
    while (asks.length && (asks[0]!.interaction.created_at ?? Infinity) < at) {
      const ask = asks.shift()!
      list.push({ key: `ask:${ask.interaction.id}`, ask })
    }
    list.push({ key: row.key, row })
  }
  for (const ask of asks) list.push({ key: `ask:${ask.interaction.id}`, ask })
  return list
})

function progress(batch: IndependentBatch): string {
  const done = batch.members.filter((id) => props.finished.includes(id)).length
  return `${done}/${batch.members.length} 已答，答完一起显示`
}
</script>

<template>
  <ol class="flow" data-group-flow>
    <li v-for="item in items" :key="item.key" class="item">
      <!-- A member asks the user (D29). -->
      <GroupAskMessage
        v-if="item.ask"
        :ask="item.ask"
        :name="person(item.ask.contactId).name"
        :avatar="person(item.ask.contactId).avatar"
        @answer="
          emit('answer', {
            contactId: item.ask.contactId,
            interaction: item.ask.interaction,
            ...$event,
          })
        "
        @cancel="
          emit('cancelAsk', {
            contactId: item.ask.contactId,
            interaction: item.ask.interaction,
          })
        "
        @process="emit('process', item.ask.contactId)"
      />

      <!-- Independent answers. -->
      <div
        v-else-if="item.row.kind === 'independent'"
        class="indep"
        data-group-row
        data-kind="independent"
      >
        <div class="indep-head">
          <span>独立作答 · {{ item.row.batch.members.length }} 人</span>
          <span class="indep-why">都答完后一起显示，避免互相带偏</span>
        </div>
        <div v-if="item.row.batch.revealed" class="cols">
          <div
            v-for="answer in item.row.batch.answers"
            :key="answer.id"
            class="col"
            data-answer
          >
            <div class="who small">
              <span
                class="face"
                :data-missing="person(answer.from).missing || undefined"
              >
                <Avatar v-bind="person(answer.from).avatar" :size="20" />
              </span>
              <b>{{ person(answer.from).name }}</b>
              <LinkButton
                v-if="person(answer.from).sessionId"
                class="process"
                data-process
                @click="emit('process', answer.from)"
                >过程 ›</LinkButton
              >
            </div>
            <GroupMarkdown class="body" :content="answer.text" :names="names" />
          </div>
        </div>
        <div v-else class="waiting">
          <span class="progress" data-progress>{{
            progress(item.row.batch)
          }}</span>
          <span
            v-for="id in item.row.batch.members"
            :key="id"
            class="waiting-face"
            :data-done="finished.includes(id) || undefined"
            :title="person(id).name"
          >
            <Avatar v-bind="person(id).avatar" :size="20" />
          </span>
        </div>
      </div>

      <!-- The system. -->
      <div
        v-else-if="item.row.kind === 'system'"
        class="sys"
        :data-tone="WARN.test(item.row.message.text) ? 'warn' : undefined"
        data-group-row
        data-kind="system"
      >
        <span>{{ item.row.message.text }}</span>
        <LinkButton
          v-if="settingsLink(item.row.message.text)"
          class="sys-link"
          @click="
            emit('openSettings', settingsLink(item.row.message.text)!.section)
          "
          >打开{{ settingsLink(item.row.message.text)!.label }}设置</LinkButton
        >
      </div>

      <!-- The user: a bubble on the right. -->
      <div
        v-else-if="item.row.message.from === 'user'"
        class="me"
        data-group-row
        :data-kind="item.row.kind"
      >
        <span
          class="to"
          :data-tone="
            item.row.kind === 'task'
              ? 'task'
              : item.row.message.audience.kind === 'private'
                ? 'dm'
                : undefined
          "
          >{{
            item.row.kind === 'task' && item.row.message.task
              ? `交办 → ${nameOf(item.row.message.task.to)}`
              : audience(item.row.message)
          }}</span
        >
        <div
          v-if="
            item.row.kind !== 'task' ||
            item.row.message.text !== item.row.message.task?.title
          "
          class="bubble"
        >
          <template
            v-for="(segment, index) in mentionSegments(
              item.row.message.text,
              names,
            )"
            :key="index"
          >
            <span v-if="segment.mention" class="mention">{{
              segment.text
            }}</span>
            <template v-else>{{ segment.text }}</template>
          </template>
        </div>
        <GroupTaskCard
          v-if="item.row.kind === 'task' && item.row.message.task"
          :task="item.row.message.task"
          @confirm="
            emit('confirmTask', {
              taskId: item.row.message.task.taskId,
              approve: $event,
            })
          "
        />
      </div>

      <!-- Nothing to add. -->
      <div
        v-else-if="item.row.kind === 'pass'"
        class="pass"
        data-group-row
        data-kind="pass"
      >
        <span
          class="face"
          :data-missing="person(item.row.message.from).missing || undefined"
        >
          <Avatar v-bind="person(item.row.message.from).avatar" :size="16" />
        </span>
        <span
          >{{ person(item.row.message.from).name }} 没有补充{{
            item.row.message.text ? `：${item.row.message.text}` : ''
          }}</span
        >
      </div>

      <!-- A member speaks: say, private, task, result, summary. -->
      <div v-else class="msg" data-group-row :data-kind="item.row.kind">
        <span
          class="face"
          :data-missing="person(item.row.message.from).missing || undefined"
        >
          <Avatar v-bind="person(item.row.message.from).avatar" :size="28" />
        </span>
        <div class="main">
          <div class="who">
            <b>{{ person(item.row.message.from).name }}</b>
            <span v-if="person(item.row.message.from).intro" class="role">{{
              person(item.row.message.from).intro
            }}</span>
            <span
              v-if="
                item.row.kind === 'private' &&
                item.row.message.audience.kind === 'private'
              "
              class="to"
              data-tone="dm"
              data-private-label
              >{{ privateLabel(nameOf(item.row.message.audience.to)) }}</span
            >
            <span
              v-else-if="item.row.kind === 'task' && item.row.message.task"
              class="to"
              data-tone="task"
              >交办 → {{ nameOf(item.row.message.task.to) }}</span
            >
            <span
              v-else-if="item.row.kind === 'result'"
              class="to"
              data-tone="task"
              >交回{{
                taskTitle(item.row.message.replyTo)
                  ? ` · ${taskTitle(item.row.message.replyTo)}`
                  : ''
              }}</span
            >
            <span
              v-else-if="item.row.kind === 'summary'"
              class="to"
              data-tone="gold"
              >结论</span
            >
            <span v-else-if="item.row.message.ask.length" class="to">{{
              audience(item.row.message)
            }}</span>
            <LinkButton
              v-if="person(item.row.message.from).sessionId"
              class="process"
              data-process
              @click="emit('process', item.row.message.from)"
              >过程 ›</LinkButton
            >
          </div>
          <GroupTaskCard
            v-if="item.row.kind === 'task' && item.row.message.task"
            :task="item.row.message.task"
            @confirm="
              emit('confirmTask', {
                taskId: item.row.message.task.taskId,
                approve: $event,
              })
            "
          />
          <template v-else>
            <div
              class="body"
              :data-kind="item.row.kind"
              :data-folded="folded(item.row.message) || undefined"
            >
              <GroupMarkdown :content="item.row.message.text" :names="names" />
            </div>
            <LinkButton
              v-if="isLongMessage(item.row.message.text)"
              class="fold"
              @click="toggleFold(item.row.message.id)"
              >{{ folded(item.row.message) ? '展开全文' : '收起' }}</LinkButton
            >
            <GroupResultCard
              v-if="
                item.row.kind === 'result' &&
                item.row.message.delegation &&
                person(item.row.message.from).sessionId
              "
              :delegation="item.row.message.delegation"
              :session-id="person(item.row.message.from).sessionId!"
            />
          </template>
        </div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.flow {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-direction: column;
}

.msg {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: var(--space-2-5);
  max-width: 780px;
}

.main {
  min-width: 0;
}

.face {
  display: inline-flex;
  border-radius: var(--r-full);
}

.face[data-missing] {
  filter: grayscale(1);
  opacity: 0.55;
}

.who {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.who b {
  font-weight: var(--weight-semibold);
}

.role {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
}

.process {
  margin-left: auto;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
}

.to {
  padding: 0 var(--space-1-5);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
  color: rgb(var(--text-2));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxs);
}

.to[data-tone='dm'] {
  background: color-mix(in srgb, rgb(var(--tone-violet)) 14%, transparent);
  box-shadow: none;
  color: rgb(var(--tone-violet));
}

.to[data-tone='task'] {
  background: rgb(var(--info-soft));
  box-shadow: none;
  color: rgb(var(--info));
}

.to[data-tone='gold'] {
  background: rgb(var(--accent-soft));
  box-shadow: none;
  color: rgb(var(--text-link));
}

.body {
  margin-top: var(--space-0-5);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  overflow-wrap: anywhere;
}

.body :deep(.markdown-body) {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.body[data-folded] {
  max-height: calc(var(--lh-s) * 12);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 70%, transparent);
}

.body[data-kind='private'] {
  padding-left: var(--space-2-5);
  box-shadow: inset 2px 0 0 rgb(var(--tone-violet));
  color: rgb(var(--text-2));
}

.body[data-kind='summary'] {
  padding: var(--space-2-5) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 0.5px rgb(var(--accent) / 0.35);
}

.fold {
  margin-top: var(--space-1);
  font-size: var(--fs-xxs);
}

.me {
  display: grid;
  justify-items: end;
  gap: var(--space-1);
  max-width: 780px;
}

.bubble {
  max-width: 80%;
  padding: var(--space-2) var(--space-3-5);
  border-radius: var(--r-lg) var(--r-lg) var(--r-xs) var(--r-lg);
  background: rgb(var(--bubble-user));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mention {
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
  font-weight: var(--weight-medium);
}

.sys {
  display: flex;
  flex-wrap: wrap;
  align-self: center;
  justify-content: center;
  gap: var(--space-1) var(--space-2);
  max-width: 780px;
  padding: var(--space-0-5) var(--space-2-5);
  border-radius: var(--r-lg);
  background: rgb(var(--surface-raised));
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-align: center;
}

.sys[data-tone='warn'] {
  background: rgb(var(--attention-soft));
  color: rgb(var(--attention));
}

.sys-link {
  font-size: var(--fs-xxs);
}

.pass {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.indep {
  display: grid;
  gap: var(--space-2);
  max-width: 780px;
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-lg);
  background: rgb(var(--surface-base));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.indep-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.indep-why {
  margin-left: auto;
}

.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-2);
}

.col {
  display: grid;
  align-content: start;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.who.small {
  font-size: var(--fs-xxs);
}

.waiting {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
}

.progress {
  margin-right: var(--space-1);
}

.waiting-face {
  display: inline-flex;
  border-radius: var(--r-full);
  opacity: 0.45;
}

.waiting-face[data-done] {
  opacity: 1;
  box-shadow: 0 0 0 1.5px rgb(var(--ok));
}
</style>
