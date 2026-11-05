<script setup lang="ts">
/**
 * GroupConversation — the group's message flow (GRP-08, 预览 B 第 3 步,
 * docs/design/agent-contacts.md § 群聊页), oldest first:
 * - the user: a warm bubble on the right, its audience above it
 *   (「→ 所有人」, 「→ @架构师」, 「🔒 私信 → 写作者」);
 * - say: avatar, name, role and audience, what was said (Markdown, @
 *   marked); execution details stay in the right-hand member view;
 * - independent answers: ordinary member messages once revealed; hidden
 *   answers occupy no row and their progress stays in the right rail;
 * - private: a violet line and 「🔒 私信 → X · 其他成员看不到，你能看到」;
 * - task and result: the original assignment and delivery as dialogue;
 *   public files/images are inline attachments on the delivery;
 * - summary: the moderator's conclusion on a light gold ground;
 * - system: one centred line (a 「设置 › …」 in it becomes a button);
 * - note: what the user answered a member, as the group log keeps it for
 *   the user only (GRP-12) — one centred line, the question on hover;
 * - pass: one faint line, 「架构师 没有补充」.
 * Members' tool steps never show here. A message past 12 lines folds. A
 * member's question or approval waiting in its own session shows as its
 * message where it was asked (D29). A deleted contact is greyed out.
 *
 * Props: messages; members; contacts; finished (members done speaking in
 * this turn); asks; streams (the speeches still being written, GRP-20).
 * Emits: process(contactId), answer, cancelAsk, artifact preview/get,
 * openSettings.
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
import GroupArtifacts from './GroupArtifacts.vue'
import { mentionedContacts } from './groupHomeModel'
import {
  isLongMessage,
  mentionSegments,
  privateLabel,
  timelineRows,
  type GroupAsk,
  type GroupHistoryMessage,
  type GroupMemberView,
  type TimelineRow,
} from './groupModel'
import { useSkinExempt } from '../../skin/skinState'
import type { GroupStreamView } from './useGroupRoom'

/** BRD-05 (D8): a skin may not reach this zone. */
const exempt = useSkinExempt()

const props = withDefaults(
  defineProps<{
    messages: readonly GroupHistoryMessage[]
    members: readonly GroupMemberView[]
    contacts: readonly Contact[]
    asks: readonly GroupAsk[]
    streams?: readonly GroupStreamView[]
    groupId: string
    artifacts?: readonly import('./groupModel').GroupArtifactFile[]
  }>(),
  { streams: () => [], artifacts: () => [] },
)
const emit = defineEmits<{
  process: [contactId: string]
  answer: [
    payload: {
      contactId: string
      interaction: ControlInteraction
      answers: Record<string, unknown>
    },
  ]
  cancelAsk: [payload: { contactId: string; interaction: ControlInteraction }]
  previewArtifact: [payload: { ref: string; name: string; mimeType: string }]
  getArtifact: [ref: string]
  openSettings: [section: SettingsModalSection]
}>()

interface Person {
  name: string
  intro: string
  avatar:
    ReturnType<typeof contactAvatarProps> | { kind: 'initials'; label: string }
  missing: boolean
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
    }
  const name = contact?.name ?? member?.name ?? id
  return {
    name,
    intro: contact?.intro ?? member?.intro ?? '',
    avatar: contact
      ? contactAvatarProps(contact.avatar, contact.name)
      : { kind: 'initials', label: name },
    missing: false,
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

/** Legacy system coordination is spoken by the fixed visible member. */
function speakerId(row: TimelineRow): string {
  return row.kind === 'coordination' ? 'ct-emperor' : row.message.from
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

/** The question an answer answered, on hover (an approval's is in the line). */
function noteTitle(message: GroupHistoryMessage): string | undefined {
  const note = message.note
  return note?.outcome === 'answered' && note.asked ? note.asked : undefined
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

// ── one chronological flow: history, source-anchored asks and live prose ──
type Item =
  | { key: string; row: TimelineRow; ask?: undefined; stream?: undefined }
  | { key: string; ask: GroupAsk; row?: undefined; stream?: undefined }
  | {
      key: string
      stream: GroupStreamView
      row?: undefined
      ask?: undefined
    }

function speaker(item: Item): string | null {
  if (item.ask) return item.ask.contactId
  if (item.stream) return item.stream.contactId
  if (item.row.kind === 'note' || item.row.kind === 'system') return null
  return item.row.message.from === 'user' ? 'user' : speakerId(item.row)
}

function continuous(index: number): boolean {
  if (index === 0) return false
  const current = speaker(items.value[index]!)
  return current !== null && current === speaker(items.value[index - 1]!)
}

const items = computed<Item[]>(() => {
  const rows = timelineRows(props.messages)
  const sources = new Set(
    rows.map((row) => row.message.interactionId).filter(Boolean),
  )
  const sortedAsks = [...props.asks].sort(
    (a, b) =>
      (a.interaction.created_at ?? Number.MAX_SAFE_INTEGER) -
      (b.interaction.created_at ?? Number.MAX_SAFE_INTEGER),
  )
  const anchored = new Map<string, GroupAsk[]>()
  const fallback: GroupAsk[] = []
  for (const ask of sortedAsks) {
    const source = rows.find(
      (row) => row.message.interactionId === ask.interaction.id,
    )?.message.interactionId
    if (source && sources.has(source)) {
      const list = anchored.get(source) ?? []
      list.push(ask)
      anchored.set(source, list)
    } else fallback.push(ask)
  }

  let order = 0
  const base: Array<{ at: number; order: number; item: Item }> = [
    ...rows.map((row) => ({
      at: row.message.at,
      order: order++,
      item: { key: row.key, row } as Item,
    })),
    ...props.streams.map((stream) => ({
      at: stream.startedAt,
      order: order++,
      item: { key: `stream:${stream.contactId}`, stream } as Item,
    })),
  ].sort((a, b) => a.at - b.at || a.order - b.order)

  const list: Item[] = []
  for (const entry of base) {
    while (
      fallback.length &&
      (fallback[0]!.interaction.created_at ?? Infinity) < entry.at
    ) {
      const ask = fallback.shift()!
      list.push({ key: `ask:${ask.interaction.id}`, ask })
    }
    list.push(entry.item)
    const interactionId = entry.item.row?.message.interactionId
    for (const ask of anchored.get(interactionId ?? '') ?? [])
      list.push({ key: `ask:${ask.interaction.id}`, ask })
  }
  for (const ask of fallback)
    list.push({ key: `ask:${ask.interaction.id}`, ask })
  return list
})
</script>

<template>
  <ol class="flow" data-group-flow :style="exempt">
    <li
      v-for="(item, itemIndex) in items"
      :key="item.key"
      class="item"
      :data-continuous="continuous(itemIndex) || undefined"
    >
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

      <!-- Live prose occupies its actual chronological position. -->
      <div
        v-else-if="item.stream"
        class="msg streaming"
        data-group-streaming
        :data-stream-contact="item.stream.contactId"
      >
        <span
          class="face"
          :data-missing="person(item.stream.contactId).missing || undefined"
        >
          <Avatar v-bind="person(item.stream.contactId).avatar" :size="32" />
        </span>
        <div class="main">
          <div class="who">
            <b>{{ person(item.stream.contactId).name }}</b>
            <span v-if="item.stream.contactId === 'ct-emperor'" class="fixed"
              >内置协调</span
            >
            <span class="live">发言中</span>
          </div>
          <div class="body">
            <GroupMarkdown :content="item.stream.text" :names="names" />
          </div>
        </div>
      </div>

      <!-- What the user answered a member (GRP-12). -->
      <div
        v-else-if="item.row.kind === 'note'"
        class="sys"
        :title="noteTitle(item.row.message)"
        data-group-row
        data-kind="note"
      >
        <span>{{ item.row.message.text }}</span>
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
        :data-task-id="item.row.message.task?.taskId"
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
        <div class="bubble">
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
        <span class="face me-face">
          <Avatar kind="initials" label="我" :size="32" />
        </span>
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
          :data-missing="person(speakerId(item.row)).missing || undefined"
        >
          <Avatar v-bind="person(speakerId(item.row)).avatar" :size="16" />
        </span>
        <span
          >{{ person(speakerId(item.row)).name }} 没有补充{{
            item.row.message.text ? `：${item.row.message.text}` : ''
          }}</span
        >
      </div>

      <!-- A member speaks: say, private, task, result, summary. -->
      <div
        v-else
        class="msg"
        data-group-row
        :data-kind="item.row.kind"
        :data-task-id="item.row.message.task?.taskId"
      >
        <span
          class="face"
          :data-missing="person(speakerId(item.row)).missing || undefined"
        >
          <Avatar v-bind="person(speakerId(item.row)).avatar" :size="32" />
        </span>
        <div class="main">
          <div class="who">
            <b>{{ person(speakerId(item.row)).name }}</b>
            <span v-if="speakerId(item.row) === 'ct-emperor'" class="fixed"
              >内置协调</span
            >
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
          </div>
          <div
            class="body"
            :data-kind="item.row.kind"
            :data-folded="folded(item.row.message) || undefined"
          >
            <GroupMarkdown :content="item.row.message.text" :names="names" />
            <GroupArtifacts
              v-if="
                item.row.kind === 'result' &&
                item.row.message.task?.artifacts?.length
              "
              :group-id="groupId"
              :artifacts="item.row.message.task.artifacts"
              :files="artifacts"
              @preview="emit('previewArtifact', $event)"
              @get="emit('getArtifact', $event)"
            />
          </div>
          <LinkButton
            v-if="isLongMessage(item.row.message.text)"
            class="fold"
            @click="toggleFold(item.row.message.id)"
            >{{ folded(item.row.message) ? '展开全文' : '收起' }}</LinkButton
          >
        </div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.flow {
  width: 100%;
  max-width: var(--chat-content-width, 748px);
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0 auto;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-direction: column;
}

.item + .item {
  margin-top: var(--space-4);
}

.msg {
  display: grid;
  grid-template-columns: var(--space-8) minmax(0, 1fr);
  gap: var(--space-2-5);
  width: 100%;
}

.main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.item[data-continuous] {
  margin-top: calc(var(--space-1) + 1px);
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
  gap: var(--space-1-5);
  margin-bottom: var(--space-1);
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

.fixed {
  padding: 0 calc(var(--space-1) + 1px);
  border-radius: var(--r-xs);
  background: rgb(var(--accent-soft));
  color: rgb(var(--text-link));
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
  width: fit-content;
  max-width: min(680px, 88%);
  padding: var(--space-2) calc(var(--space-2-5) + 1px);
  border-radius: var(--r-xs) var(--r-md) var(--r-md) var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--hairline);
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
  background: color-mix(
    in srgb,
    rgb(var(--tone-violet)) 9%,
    rgb(var(--surface-raised))
  );
  box-shadow: inset 0 0 0 0.5px rgb(var(--tone-violet) / 0.3);
  color: rgb(var(--text-2));
}

.body[data-kind='summary'] {
  background: rgb(var(--accent-soft));
  box-shadow: inset 0 0 0 0.5px rgb(var(--accent) / 0.35);
}

.fold {
  margin-top: var(--space-1);
  font-size: var(--fs-xxs);
}

.me {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--space-8);
  justify-items: end;
  gap: var(--space-1) var(--space-2-5);
  width: 100%;
}

.me > .to {
  grid-column: 1;
}

.me-face {
  grid-column: 2;
  grid-row: 1 / span 2;
}

.bubble {
  grid-column: 1;
  max-width: min(680px, 88%);
  padding: var(--space-2) calc(var(--space-2-5) + 1px);
  border-radius: var(--r-md) var(--r-xs) var(--r-md) var(--r-md);
  background: rgb(var(--bubble-user));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.live {
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: rgb(var(--info) / 0.14);
  color: rgb(var(--info));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}

.streaming .body::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: rgb(var(--text-2));
  animation: group-caret 1s steps(1) infinite;
}

@keyframes group-caret {
  50% {
    opacity: 0;
  }
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
