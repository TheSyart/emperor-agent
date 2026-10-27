<script setup lang="ts">
/**
 * GroupHomeComposer — the Group home's input (GRP-05, 预览 A): type a message
 * and @ the contacts it is for. Typing @ lists the contacts whose name has
 * what follows (↑ ↓ choose, Enter or Tab take one, Esc closes; a name that
 * is no contact's is never offered); 「@ 提到联系人」 starts one. Enter sends
 * (Shift+Enter is a new line); GroupHome decides what sending does.
 *
 * Props: modelValue (v-model, the text); contacts; busy?.
 * Emits: send.
 */
import { computed, nextTick, ref } from 'vue'
import type { Contact } from '@emperor/core/api'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { DsArrowUp } from '../icons/ds'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import TextArea from '../ui/TextArea.vue'
import { completionMatches, completionQuery } from './groupHomeModel'

const props = withDefaults(
  defineProps<{ contacts: readonly Contact[]; busy?: boolean }>(),
  { busy: false },
)
const text = defineModel<string>({ default: '' })
const emit = defineEmits<{ send: [] }>()

const root = ref<HTMLElement | null>(null)
const caret = ref(0)
const index = ref(0)
/** The @ whose list the user closed with Esc (it stays closed). */
const dismissed = ref<number | null>(null)

function area(): HTMLTextAreaElement | null {
  return root.value?.querySelector('textarea') ?? null
}

const query = computed(() => {
  const found = completionQuery(text.value, caret.value)
  return found && found.start !== dismissed.value ? found : null
})
const matches = computed(() =>
  query.value ? completionMatches(query.value.query, props.contacts) : [],
)

function track() {
  const element = area()
  if (!element) return
  const next = element.selectionStart ?? text.value.length
  if (next !== caret.value) index.value = 0
  caret.value = next
}

function onInput() {
  track()
  if (dismissed.value !== null && !query.value) dismissed.value = null
}

async function pick(contact: Contact) {
  const found = query.value
  if (!found) return
  const before = text.value.slice(0, found.start)
  const after = text.value.slice(caret.value)
  const inserted = `@${contact.name} `
  text.value = `${before}${inserted}${after}`
  const position = before.length + inserted.length
  caret.value = position
  index.value = 0
  await nextTick()
  const element = area()
  element?.focus()
  element?.setSelectionRange(position, position)
}

/** 「@ 提到联系人」: an @ at the caret, then the list. */
async function startMention() {
  const element = area()
  const at = element?.selectionStart ?? text.value.length
  const before = text.value.slice(0, at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  text.value = `${before}${lead}@${text.value.slice(at)}`
  const position = at + lead.length + 1
  caret.value = position
  dismissed.value = null
  await nextTick()
  element?.focus()
  element?.setSelectionRange(position, position)
}

function onKeydown(event: KeyboardEvent) {
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
    if (count && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault()
      void pick(matches.value[Math.min(index.value, count - 1)]!)
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('send')
  }
}
</script>

<template>
  <div ref="root" class="composer" data-home-composer>
    <TextArea
      v-model="text"
      class="input"
      :min-rows="2"
      :max-rows="8"
      placeholder="@ 提到联系人，说说要做什么"
      aria-label="给联系人发消息"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="track"
      @click="track"
    />
    <ul
      v-if="query"
      class="matches"
      role="listbox"
      aria-label="联系人"
      data-mention-list
    >
      <li
        v-for="(contact, at) in matches"
        :key="contact.id"
        class="match"
        role="option"
        :aria-selected="at === index"
        :data-contact="contact.id"
        @mousedown.prevent="pick(contact)"
      >
        <Avatar
          v-bind="contactAvatarProps(contact.avatar, contact.name)"
          :size="20"
        />
        <span class="match-name">{{ contact.name }}</span>
        <span class="match-intro">{{ contact.intro }}</span>
      </li>
      <li v-if="!matches.length" class="match-empty">
        没有叫「{{ query.query }}」的联系人
      </li>
    </ul>
    <div class="bar">
      <Button size="sm" @click="startMention">@ 提到联系人</Button>
      <IconButton
        class="send"
        label="发送"
        variant="primary"
        shape="circle"
        :disabled="busy || !text.trim()"
        @click="emit('send')"
      >
        <DsArrowUp :size="16" />
      </IconButton>
    </div>
  </div>
</template>

<style scoped>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2-5) var(--space-3-5);
  border-radius: var(--r-xl);
  background: rgb(var(--composer-fill));
  box-shadow: var(--composer-edge);
}

.input {
  padding: 0;
  background: transparent;
  box-shadow: none;
  resize: none;
  font-size: var(--fs-base);
  line-height: var(--lh-base);
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
}

.send {
  margin-left: auto;
}
</style>
