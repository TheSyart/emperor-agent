<script setup lang="ts">
/**
 * GroupHome — the Group mode's home, `/contacts` (GRP-05, 预览 A, D12):
 * 「今天找谁帮忙？」, a composer for @-mentioning contacts, then the
 * contacts and the recent groups.
 *
 * Sending: @ one contact opens its most recent single chat
 * (`contacts.openChat`) with the message handed over to be sent there; @
 * two or more make a temporary group of them with Emperor as moderator
 * (`groups.create`), the message going in as a mention (`groups.send`),
 * named after its first sentence (groupHomeModel.ts). No @ asks for one; an
 * @ that names no contact stops before anything is sent. Claude Code and
 * Codex have no single chat yet: @ them with someone else for a group.
 *
 * A contact opens its profile; 新建 the contact editor; a group card the
 * group's page. 新建群聊 waits for GRP-08.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import type { SessionInfo } from '../../types'
import { sidebarRelativeTime } from '../../runtime/sidebarModel'
import { handDraftTo } from '../chat/draftHandoff'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { useContactDirectory } from '../contacts/contactDirectory'
import EmptyHero from '../conversation/EmptyHero.vue'
import { DsPlus } from '../icons/ds'
import Avatar from '../ui/Avatar.vue'
import Surface from '../ui/Surface.vue'
import { COMING_SOON } from '../sidebar/modeEntries'
import GroupHomeComposer from './GroupHomeComposer.vue'
import { planHomeSend } from './groupHomeModel'

const router = useRouter()
const ctx = useAppContext()
const sessionStore = useSession()
const directory = useContactDirectory()

const text = ref('')
const hint = ref('')
const sending = ref(false)

const contacts = computed(() => directory.contacts.value)
/** The recent groups the home shows. */
const RECENT_GROUPS = 5
const recentGroups = computed(() =>
  directory.groups.value.slice(0, RECENT_GROUPS),
)

const plan = computed(() => planHomeSend(text.value, contacts.value))
const nameOf = (id: string) =>
  contacts.value.find((contact) => contact.id === id)?.name ?? id

/** What sending will do, under the composer (单聊 / 建临时群). */
const planLine = computed(() => {
  const current = plan.value
  if (current.kind === 'chat')
    return `发出后打开和「${nameOf(current.contactId)}」的单聊`
  if (current.kind === 'group')
    return `发出后建临时群「${current.title}」：${current.ask
      .map(nameOf)
      .join('、')}，Emperor 主持`
  return ''
})

watch(text, () => {
  hint.value = ''
})

function shortRole(intro: string, external: boolean): string {
  const line = intro.split(/[，。,.;；·]/)[0]?.trim() ?? ''
  if (line) return Array.from(line).slice(0, 6).join('')
  return external ? '外部' : '联系人'
}

function groupLine(memberCount: number, lastMessageAt: number | null): string {
  const when = lastMessageAt
    ? sidebarRelativeTime(new Date(lastMessageAt).toISOString())
    : '还没有消息'
  return `${memberCount} 人 · ${when}`
}

function openContact(id: string) {
  void router.push({ name: 'contact', params: { id } }).catch(() => undefined)
}

function newContact() {
  void router.push({ name: 'contact-new' }).catch(() => undefined)
}

function openGroup(groupId: string) {
  void router
    .push({ name: 'group', params: { groupId } })
    .catch(() => undefined)
}

async function send() {
  if (sending.value) return
  const message = text.value
  const current = plan.value
  switch (current.kind) {
    case 'empty':
      return
    case 'none':
      hint.value = '先 @ 一位联系人：输入 @ 就能选人'
      return
    case 'unknown':
      hint.value = `没有叫「${current.names.join('」「')}」的联系人：改一下名字，或者去掉 @`
      return
    default:
      break
  }
  if (current.kind === 'chat') {
    const contact = contacts.value.find((item) => item.id === current.contactId)
    if (contact?.kind === 'external') {
      hint.value = `和「${contact.name}」单聊即将推出；再 @ 一位联系人，就会和它一起建一个临时群`
      return
    }
  }
  sending.value = true
  try {
    if (current.kind === 'chat') {
      const session = (await core('contacts.openChat', {
        id: current.contactId,
      })) as SessionInfo
      sessionStore.adopt(session)
      handDraftTo(session.id, message, { send: true })
      text.value = ''
      await router.push({ name: 'chat', params: { sessionId: session.id } })
      return
    }
    const group = await core('groups.create', {
      title: current.title,
      members: current.members,
      moderator: current.moderator,
    })
    await core('groups.send', {
      id: group.id,
      way: 'mention',
      text: message,
      ask: current.ask,
    })
    text.value = ''
    await router.push({ name: 'group', params: { groupId: group.id } })
  } catch (error) {
    ctx.showError(error, '没有发出去')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="group-home" data-group-home>
    <div class="center">
      <EmptyHero mode="group" />
      <GroupHomeComposer
        v-model="text"
        :contacts="contacts"
        :busy="sending"
        @send="send"
      />
      <p v-if="hint" class="hint" role="status" data-home-hint>{{ hint }}</p>
      <p v-else-if="planLine" class="plan" data-send-plan>{{ planLine }}</p>

      <section class="block" aria-label="联系人">
        <h2 class="block-title">联系人</h2>
        <div class="people">
          <div
            v-for="contact in contacts"
            :key="contact.id"
            class="person"
            role="button"
            tabindex="0"
            :data-person="contact.id"
            :title="contact.intro || contact.name"
            @click="openContact(contact.id)"
            @keydown.enter.self="openContact(contact.id)"
            @keydown.space.self.prevent="openContact(contact.id)"
          >
            <Avatar
              v-bind="contactAvatarProps(contact.avatar, contact.name)"
              :size="40"
            />
            <span class="person-name">{{ contact.name }}</span>
            <span class="person-role">{{
              shortRole(contact.intro, contact.kind === 'external')
            }}</span>
          </div>
          <div
            class="person"
            role="button"
            tabindex="0"
            data-person="new"
            @click="newContact"
            @keydown.enter.self="newContact"
            @keydown.space.self.prevent="newContact"
          >
            <span class="add-tile" aria-hidden="true"
              ><DsPlus :size="16"
            /></span>
            <span class="person-name">新建</span>
            <span class="person-role">联系人</span>
          </div>
        </div>
      </section>

      <section class="block" aria-label="最近的群">
        <h2 class="block-title">最近的群</h2>
        <div class="cards">
          <Surface
            v-for="group in recentGroups"
            :key="group.id"
            as="button"
            pad="sm"
            interactive
            class="card"
            :data-group-card="group.id"
            @click="openGroup(group.id)"
          >
            <span class="card-title">{{ group.title }}</span>
            <span class="card-meta">{{
              groupLine(group.memberCount, group.lastMessageAt)
            }}</span>
          </Surface>
          <Surface
            pad="sm"
            class="card"
            aria-disabled="true"
            :title="COMING_SOON"
            data-group-card="new"
          >
            <span class="card-title">新建群聊</span>
            <span class="card-meta">从模板建群{{ COMING_SOON }}</span>
          </Surface>
        </div>
        <p v-if="directory.loaded.value && !recentGroups.length" class="empty">
          还没有群：在上面 @ 两位联系人，就会建一个临时群
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.group-home {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  width: min(calc(640px + 2 * var(--space-4)), 100%);
  margin: auto;
  padding: var(--space-8) var(--space-4);
}

.hint,
.plan {
  align-self: stretch;
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.hint {
  color: rgb(var(--attention));
}

.plan {
  color: rgb(var(--text-3));
}

.block {
  position: relative;
  display: flex;
  flex-direction: column;
  align-self: stretch;
  gap: var(--space-2-5);
  margin-top: var(--space-2);
}

.block-title {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-medium);
}

.people {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.person {
  display: grid;
  justify-items: center;
  gap: var(--space-1);
  width: 76px;
  padding: var(--space-1);
  border-radius: var(--r-md);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  cursor: pointer;
  outline: none;
}

.person:hover {
  background: var(--surface-hover);
}

.person:focus-visible {
  box-shadow: inset 0 0 0 2px rgb(var(--focus-ring) / 0.5);
}

.person-name,
.person-role {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.person-role {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.add-tile {
  display: inline-grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  background: var(--surface-hover);
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-2));
}

.cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2-5);
}

.card {
  display: grid;
  gap: var(--space-1-5);
  min-width: 0;
  text-align: left;
}

.card[aria-disabled='true'] {
  opacity: 0.55;
}

.card-title,
.card-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-title {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-medium);
}

.card-meta {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.empty {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

@media (max-width: 760px) {
  .cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
