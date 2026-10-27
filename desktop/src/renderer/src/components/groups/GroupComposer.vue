<script setup lang="ts">
/**
 * GroupComposer — the group's input (GRP-08, 预览 B 第 3 步): 「发给 ▾」 picks
 * one of the five ways (所有人 · 举手, 各自独立回答, @ 指定成员, 私信…,
 * 交办…); a private message and a task pick their member; a task fills in
 * what to do, what to hand back, on what basis and with what access. `@`
 * lists the members (↑↓, Enter / Tab, Esc). ⌘↵ sends; Enter is a new line.
 * What cannot go yet says why under the box and nothing is sent.
 *
 * Props: members; contacts (avatars); moderator; submit (sends the
 * envelope, true when it went: the box empties, a task's form closes);
 * disabled? (a reason the group cannot take messages).
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { Contact } from '@emperor/core/api'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { DsArrowUp } from '../icons/ds'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import Chip from '../ui/Chip.vue'
import Field from '../ui/Field.vue'
import IconButton from '../ui/IconButton.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Segmented from '../ui/Segmented.vue'
import TextArea from '../ui/TextArea.vue'
import TextField from '../ui/TextField.vue'
import { completionMatches } from './groupHomeModel'
import {
  ACCESS_OPTIONS,
  completionQuery,
  planGroupSend,
  SEND_WAYS,
  sendWayOption,
  type GroupMemberView,
  type GroupSendInput,
  type SendWay,
  type TaskAccess,
} from './groupModel'

const props = withDefaults(
  defineProps<{
    members: readonly GroupMemberView[]
    contacts: readonly Contact[]
    moderator: string | null
    submit: (input: GroupSendInput) => Promise<boolean>
    disabled?: string
  }>(),
  { disabled: '' },
)

const way = ref<SendWay>('broadcast')
const text = ref('')
const to = ref('')
const title = ref('')
const deliverable = ref('')
const basis = ref('')
const access = ref<TaskAccess>('group_files')
const hint = ref('')
const sending = ref(false)

const root = ref<HTMLElement | null>(null)
const audienceAnchor = ref<HTMLElement | null>(null)
const choosing = ref(false)
const caret = ref(0)
const index = ref(0)
const dismissed = ref<number | null>(null)

const option = computed(() => sendWayOption(way.value))
const needsRecipient = computed(
  () => way.value === 'private' || way.value === 'task',
)
const placeholder = computed(() => {
  if (props.disabled) return props.disabled
  if (way.value === 'task') return '补充说明（可以不写）；⌘↵ 交办'
  if (way.value === 'private') return '只有对方能看到；⌘↵ 发出'
  return '在群里说点什么；@ 点名，⌘↵ 发出'
})

watch([text, way, to, title, deliverable], () => (hint.value = ''))

function avatarOf(member: GroupMemberView) {
  const contact = props.contacts.find((item) => item.id === member.id)
  return contact
    ? contactAvatarProps(contact.avatar, contact.name)
    : { kind: 'initials' as const, label: member.name }
}

function area(): HTMLTextAreaElement | null {
  return root.value?.querySelector('textarea') ?? null
}

const query = computed(() => {
  const found = completionQuery(text.value, caret.value)
  return found && found.start !== dismissed.value ? found : null
})
const matches = computed(() =>
  query.value
    ? completionMatches(
        query.value.query,
        props.members.filter((member) => !member.missing),
      )
    : [],
)

function track(): void {
  const element = area()
  if (!element) return
  const next = element.selectionStart ?? text.value.length
  if (next !== caret.value) index.value = 0
  caret.value = next
}

function onInput(): void {
  track()
  if (dismissed.value !== null && !query.value) dismissed.value = null
}

async function placeCaret(position: number): Promise<void> {
  caret.value = position
  await nextTick()
  const element = area()
  element?.focus()
  element?.setSelectionRange(position, position)
}

async function pick(member: GroupMemberView): Promise<void> {
  const found = query.value
  if (!found) return
  const before = text.value.slice(0, found.start)
  const after = text.value.slice(caret.value)
  const inserted = `@${member.name} `
  text.value = `${before}${inserted}${after}`
  index.value = 0
  await placeCaret(before.length + inserted.length)
}

/** 「@ 成员」: an @ at the caret, then the list. */
async function startMention(): Promise<void> {
  const at = area()?.selectionStart ?? text.value.length
  const before = text.value.slice(0, at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  text.value = `${before}${lead}@${text.value.slice(at)}`
  dismissed.value = null
  await placeCaret(at + lead.length + 1)
}

function chooseWay(next: SendWay): void {
  way.value = next
  if (!needsRecipient.value) to.value = ''
  void nextTick(() => area()?.focus())
}

function openWays(event: MouseEvent): void {
  audienceAnchor.value = event.currentTarget as HTMLElement
  choosing.value = true
}

function reset(): void {
  text.value = ''
  dismissed.value = null
  if (way.value === 'task') {
    title.value = ''
    deliverable.value = ''
    basis.value = ''
    access.value = 'group_files'
    to.value = ''
    way.value = 'broadcast'
  }
  hint.value = ''
}

async function send(): Promise<void> {
  if (sending.value || props.disabled) return
  const plan = planGroupSend(
    {
      way: way.value,
      text: text.value,
      ...(to.value ? { to: to.value } : {}),
      ...(way.value === 'task'
        ? {
            task: {
              title: title.value,
              deliverable: deliverable.value,
              basis: basis.value,
              access: access.value,
            },
          }
        : {}),
    },
    props.members,
    { moderator: props.moderator },
  )
  if (!plan.ok) {
    hint.value = plan.reason
    return
  }
  sending.value = true
  try {
    if (await props.submit(plan.input)) reset()
  } finally {
    sending.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (query.value) {
    const count = matches.value.length
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissed.value = query.value.start
      return
    }
    if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      index.value = (index.value + delta + count) % count
      return
    }
    if (
      count &&
      (event.key === 'Tab' ||
        (event.key === 'Enter' && !event.metaKey && !event.ctrlKey))
    ) {
      event.preventDefault()
      void pick(matches.value[Math.min(index.value, count - 1)]!)
      return
    }
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void send()
  }
}

const canSend = computed(
  () =>
    !props.disabled &&
    !sending.value &&
    (Boolean(text.value.trim()) ||
      (way.value === 'task' && Boolean(title.value.trim()))),
)
</script>

<template>
  <div ref="root" class="composer" data-group-composer :data-way="way">
    <div v-if="needsRecipient" class="recipients" data-recipients>
      <span class="recipients-label">{{
        way === 'task' ? '交给' : '私信给'
      }}</span>
      <Chip
        v-for="member in members.filter((item) => !item.missing)"
        :key="member.id"
        :active="to === member.id"
        :aria-pressed="to === member.id"
        :data-recipient="member.id"
        @click="to = member.id"
      >
        <template #icon>
          <Avatar v-bind="avatarOf(member)" :size="16" />
        </template>
        {{ member.name }}
      </Chip>
    </div>
    <div v-if="way === 'task'" class="task-form" data-task-form>
      <Field label="任务" data-task-title>
        <TextField
          v-model="title"
          size="sm"
          placeholder="要做什么，例如：把讨论写成一页说明"
        />
      </Field>
      <Field label="交付" data-task-deliverable>
        <TextField
          v-model="deliverable"
          size="sm"
          placeholder="交出什么、什么格式"
        />
      </Field>
      <Field label="依据" data-task-basis>
        <TextField
          v-model="basis"
          size="sm"
          placeholder="可以不写，例如：本轮全部发言"
        />
      </Field>
      <Field label="权限">
        <Segmented
          v-model="access"
          :options="ACCESS_OPTIONS"
          aria-label="交办的权限"
        />
      </Field>
    </div>
    <TextArea
      v-model="text"
      class="input"
      :min-rows="1"
      :max-rows="8"
      :placeholder="placeholder"
      :disabled="Boolean(disabled)"
      aria-label="在群里发消息"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="track"
      @click="track"
    />
    <ul
      v-if="query"
      class="matches"
      role="listbox"
      aria-label="成员"
      data-mention-list
    >
      <li
        v-for="(member, at) in matches"
        :key="member.id"
        class="match"
        role="option"
        :aria-selected="at === index"
        :data-member="member.id"
        @mousedown.prevent="pick(member)"
      >
        <Avatar v-bind="avatarOf(member)" :size="20" />
        <span class="match-name">{{ member.name }}</span>
        <span class="match-intro">{{ member.intro }}</span>
      </li>
      <li v-if="!matches.length" class="match-empty">
        群里没有叫「{{ query.query }}」的成员
      </li>
    </ul>
    <div class="bar">
      <Chip tone="accent" chevron data-audience @click="openWays"
        >发给：{{ option.short }}</Chip
      >
      <Button size="sm" @click="startMention">@ 成员</Button>
      <p v-if="hint" class="hint" role="status" data-composer-hint>
        {{ hint }}
      </p>
      <IconButton
        class="send"
        label="发送"
        shortcut="⌘↵"
        variant="primary"
        shape="circle"
        :disabled="!canSend"
        @click="send"
      >
        <DsArrowUp :size="16" />
      </IconButton>
    </div>
    <Menu
      v-model:open="choosing"
      :anchor="audienceAnchor"
      :width="320"
      align="start"
      label="发给"
    >
      <MenuItem variant="label">发给</MenuItem>
      <MenuItem
        v-for="item in SEND_WAYS"
        :key="item.way"
        radio
        :selected="item.way === way"
        :description="item.hint"
        :data-way="item.way"
        @select="chooseWay(item.way)"
        >{{ item.label }}</MenuItem
      >
    </Menu>
  </div>
</template>

<style scoped>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
  width: 100%;
  max-width: 780px;
  padding: var(--space-2-5) var(--space-3-5);
  border-radius: var(--r-xl);
  background: rgb(var(--composer-fill));
  box-shadow: var(--composer-edge);
}

.input,
.input:focus,
.input:focus-visible {
  padding: 0;
  background: transparent;
  box-shadow: none;
  resize: none;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.recipients {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.recipients-label {
  margin-right: var(--space-1);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.task-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2) var(--space-3);
  padding-bottom: var(--space-2);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.matches {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  border-radius: var(--r-md);
  background: rgb(var(--menu-fill));
  box-shadow: var(--elev-2);
}

.match {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.match[aria-selected='true'],
.match:hover {
  background: var(--surface-hover);
}

.match-name {
  flex: none;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.match-intro,
.match-empty {
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.match-empty {
  padding: var(--space-1-5) var(--space-2);
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.hint {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: rgb(var(--attention));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.send {
  margin-left: auto;
}
</style>
