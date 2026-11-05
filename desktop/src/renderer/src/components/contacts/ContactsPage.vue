<script setup lang="ts">
/**
 * ContactsPage — the contacts page (GRP-21): a full page in the center
 * column, shaped like 能力 (PageShell: title, subtitle, the 新建联系人
 * action, an 880px column). A category strip over a flat grid of contact
 * cards; a card opens the profile below a 所有联系人 back link. The page
 * is route-driven: `/contacts` is the grid, `/contacts/:id` the profile,
 * so back / forward and deep links keep working. The app sidebar is left
 * alone — it still lists the groups.
 *
 * Categories are the contact's own `domains`; Claude Code and Codex are
 * 外部 and appear only there. A contact with no known domain falls into
 * 其他; a category with nothing in it is left out.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ROLE_CREATOR_CONTACT_ID } from '@emperor/core/runtime-contract'
import type { Contact } from '@emperor/core/api'
import { core } from '../../api/http'
import { useSession } from '../../composables/useSession'
import PageShell from '../pages/PageShell.vue'
import type { SettingsHeaderAction } from '../settings/settingsHeader'
import Avatar from '../ui/Avatar.vue'
import EmptyState from '../ui/EmptyState.vue'
import LinkButton from '../ui/LinkButton.vue'
import Tabs from '../ui/Tabs.vue'
import { contactAvatarProps } from './contactAvatar'
import ContactProfile from './ContactProfile.vue'
import { useContactDirectory } from './contactDirectory'
import { DOMAIN_LABELS } from './contactProfileModel'
import { activeContactCategory, contactCategories } from './contactsCategories'

const route = useRoute()
const router = useRouter()
const directory = useContactDirectory()
const sessions = useSession()
const openingCreator = ref(false)
const actionError = ref('')

const categories = computed(() => contactCategories(directory.contacts.value))

const active = computed(
  () =>
    categories.value.find(
      (category) => category.id === activeContactCategory.value,
    ) ?? categories.value[0],
)
const visibleContacts = computed(() => active.value?.contacts ?? [])
const tabItems = computed(() =>
  categories.value.map((category) => ({
    id: category.id,
    label: category.label,
    count: category.contacts.length,
  })),
)

const activeId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})

const actions = computed<SettingsHeaderAction[]>(() => [
  {
    id: 'new-contact',
    label: '新建联系人',
    kind: 'primary',
    onClick: () => router.push({ name: 'contact-new' }),
  },
])

function line(contact: Contact): string {
  if (contact.intro.trim()) return contact.intro
  return contact.kind === 'external' ? '外部' : '还没有简介'
}

async function open(id: string): Promise<void> {
  actionError.value = ''
  if (id !== ROLE_CREATOR_CONTACT_ID) {
    await router
      .push({ name: 'contact', params: { id } })
      .catch(() => undefined)
    return
  }
  if (openingCreator.value) return
  openingCreator.value = true
  try {
    const session = await core('contacts.openChat', {
      id: ROLE_CREATOR_CONTACT_ID,
      intent: { action: 'create' },
    })
    sessions.adopt(session)
    await router.push({ name: 'chat', params: { sessionId: session.id } })
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    openingCreator.value = false
  }
}

function backToList(): void {
  void router.push({ name: 'contacts' }).catch(() => undefined)
}
</script>

<template>
  <PageShell
    title="联系人"
    subtitle="你的联系人与外部智能体"
    :actions="actions"
  >
    <div class="contacts-page" data-contacts-page>
      <template v-if="!activeId">
        <Tabs
          v-model="activeContactCategory"
          class="tabs"
          :tabs="tabItems"
          aria-label="联系人分类"
        />
        <div class="grid" data-contact-grid>
          <div
            v-for="contact in visibleContacts"
            :key="contact.id"
            class="card"
            role="button"
            tabindex="0"
            :data-contact-card="contact.id"
            :title="contact.name"
            @click="open(contact.id)"
            @keydown.enter.self="open(contact.id)"
            @keydown.space.self.prevent="open(contact.id)"
          >
            <span class="top">
              <Avatar
                v-bind="contactAvatarProps(contact.avatar, contact.name)"
                :size="40"
              />
              <span class="name">{{ contact.name }}</span>
            </span>
            <span class="intro">{{ line(contact) }}</span>
            <span class="meta">
              <span v-if="contact.id === ROLE_CREATOR_CONTACT_ID" class="chip"
                >系统 · 创建角色</span
              >
              <template v-else-if="contact.kind === 'external'">
                <span class="chip">外部 · 只读</span>
              </template>
              <template v-else-if="contact.domains.length">
                <span
                  v-for="domain in contact.domains"
                  :key="domain"
                  class="chip"
                  >{{ DOMAIN_LABELS[domain] }}</span
                >
              </template>
              <span v-else class="chip">其他</span>
            </span>
          </div>
        </div>
        <p v-if="actionError" class="failed" role="alert">
          没有打开角色创建师：{{ actionError }}
        </p>
        <EmptyState
          v-if="
            directory.loaded.value &&
            !directory.failed.value &&
            !directory.contacts.value.length
          "
          title="还没有联系人"
          description="点右上「新建联系人」，套一个岗位模板开始。"
        />
        <p
          v-else-if="directory.loaded.value && directory.failed.value"
          class="failed"
          role="status"
        >
          联系人读取失败：{{ directory.failed.value }}
        </p>
      </template>

      <div v-else class="detail" data-contact-detail>
        <LinkButton class="back" @click="backToList">‹ 所有联系人</LinkButton>
        <ContactProfile :key="activeId" embedded />
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.contacts-page {
  min-width: 0;
}

.tabs {
  margin-bottom: var(--space-4);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(236px, 1fr));
  gap: var(--space-3);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  cursor: pointer;
}

.card:hover {
  background: rgb(var(--surface-selected));
}

.card:focus-visible {
  outline: 2px solid rgb(var(--focus-ring));
  outline-offset: 2px;
}

.top {
  display: flex;
  align-items: center;
  gap: var(--space-2-5);
  min-width: 0;
}

.name {
  overflow: hidden;
  color: rgb(var(--text-1));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.intro {
  display: -webkit-box;
  min-height: calc(var(--lh-xxs) * 2);
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  align-items: center;
}

.chip {
  padding: 1px 7px;
  border-radius: var(--r-full);
  background: rgb(var(--surface-base));
  color: rgb(var(--text-2));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}

.failed {
  margin: var(--space-2) 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.detail {
  min-width: 0;
}

.back {
  margin-bottom: var(--space-3);
}

@media (max-width: 760px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
