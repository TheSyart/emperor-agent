<script setup lang="ts">
/**
 * ContactsPage — the contacts page (GRP-21): a full page in the center
 * column, shaped like 能力 (PageShell: title, subtitle, the 新建联系人
 * action, an 880px column), with the contacts on the left and the selected
 * one's profile on the right. `/contacts` shows the list and a prompt;
 * `/contacts/:id` shows the same page with the profile. The app sidebar is
 * left alone — it still lists the groups, so a group row returns to it.
 *
 * The list re-reads through the shared contact directory (contacts_changed,
 * groups_changed); the profile is `ContactProfile` in its embedded form.
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Contact } from '@emperor/core/api'
import { DsUser } from '../icons/ds'
import PageShell from '../pages/PageShell.vue'
import type { SettingsHeaderAction } from '../settings/settingsHeader'
import Avatar from '../ui/Avatar.vue'
import EmptyState from '../ui/EmptyState.vue'
import { contactAvatarProps } from './contactAvatar'
import ContactProfile from './ContactProfile.vue'
import { useContactDirectory } from './contactDirectory'

const route = useRoute()
const router = useRouter()
const directory = useContactDirectory()

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

function open(id: string): void {
  void router.push({ name: 'contact', params: { id } }).catch(() => undefined)
}
</script>

<template>
  <PageShell
    title="联系人"
    subtitle="你的联系人与外部智能体"
    :actions="actions"
  >
    <div class="contacts-page" data-contacts-page>
      <nav class="people" aria-label="联系人">
        <div
          v-for="contact in directory.contacts.value"
          :key="contact.id"
          class="person"
          role="button"
          tabindex="0"
          :data-contact-row="contact.id"
          :aria-current="contact.id === activeId ? 'page' : undefined"
          :title="contact.name"
          @click="open(contact.id)"
          @keydown.enter.self="open(contact.id)"
          @keydown.space.self.prevent="open(contact.id)"
        >
          <Avatar
            v-bind="contactAvatarProps(contact.avatar, contact.name)"
            :size="24"
          />
          <span class="two">
            <span class="name">{{ contact.name }}</span>
            <span class="line">{{ line(contact) }}</span>
          </span>
        </div>
        <p
          v-if="directory.loaded.value && directory.failed.value"
          class="failed"
          role="status"
        >
          联系人读取失败：{{ directory.failed.value }}
        </p>
      </nav>

      <section class="detail" aria-label="联系人档案">
        <ContactProfile v-if="activeId" :key="activeId" embedded />
        <EmptyState
          v-else
          :icon="DsUser"
          title="选一位联系人查看档案"
          description="从左边选一位，看它的职责、记忆和版本。"
        />
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.contacts-page {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
}

.people {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.person {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-row);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.person:hover {
  background: rgb(var(--surface-hover));
}

.person[aria-current='page'] {
  background: rgb(var(--surface-selected));
}

.two {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.name {
  overflow: hidden;
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line {
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.failed {
  margin: var(--space-2);
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.detail {
  min-width: 0;
}

@media (max-width: 760px) {
  .contacts-page {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
  }

  .people {
    max-height: 260px;
    overflow-y: auto;
  }
}
</style>
