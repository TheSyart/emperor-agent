<script setup lang="ts">
/**
 * ContactProfile — `/contacts/:id` (GRP-05, 预览 B 第 2 步): a contact as a
 * long-standing colleague. The avatar (换头像 opens the library), the name,
 * its domains and intro; 发消息 (its most recent single chat, or a new one —
 * `contacts.openChat`), 拉进群 (a group from the list, `groups.addMember`,
 * then the group opens; GRP-08) and 编辑; four numbers
 * (`contacts.stats`: the groups it is in, how often it spoke, the user's
 * rating out of their 👍 / 👎, the version); and five tabs —
 * 职责与方法, 知识, 能力, 记忆 (each line changed or deleted, the switch),
 * 版本 (any version against another, and back to an old one: a new version,
 * history unchanged).
 *
 * Claude Code and Codex have no single chat yet; a deleted contact says it
 * is gone. Everything is read again on `contacts_changed` for this contact
 * and the numbers on `groups_changed`.
 *
 * 「⋯」 › 删除联系人 (GRP-16, not on the builtins): asks first, then
 * `contacts.delete` — its single chats stay readable, it leaves its groups
 * — and opens the Group home with the lists read again.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type {
  Contact,
  ContactCapabilityView,
  ContactExperience,
  ContactExperienceListing,
  ContactMemoryListing,
  ContactStats,
  ContactVersionEntry,
} from '@emperor/core/api'
import { onCoreEvent } from '../../api/backend'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { useSession } from '../../composables/useSession'
import type { SessionInfo } from '../../types'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Notice from '../ui/Notice.vue'
import Select from '../ui/Select.vue'
import Surface from '../ui/Surface.vue'
import Switch from '../ui/Switch.vue'
import Tabs from '../ui/Tabs.vue'
import TextField from '../ui/TextField.vue'
import IconButton from '../ui/IconButton.vue'
import { confirm } from '../ui/confirm'
import { DsMore } from '../icons/ds'
import AvatarLibraryPicker from './AvatarLibraryPicker.vue'
import { contactAvatarProps } from './contactAvatar'
import { contactChatLocation, EXTERNAL_CHAT_NOTE } from './externalChat'
import { useContactDirectory } from './contactDirectory'
import { failureText } from './contactEditorModel'
import {
  DOMAIN_LABELS,
  LENGTH_LABELS,
  PERMISSION_LABELS,
  PRESET_LABELS,
  SPEAK_LABELS,
  knowledgeLine,
  modelLine,
  profileVersions,
  ratingSummary,
  versionChanges,
} from './contactProfileModel'

const route = useRoute()
const router = useRouter()

/**
 * `embedded` draws the profile as the right pane of the contacts page
 * (GRP-21): no page background, no crumb bar, no second scroll or width
 * cap. A route of its own is still the full page.
 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
})
const ctx = useAppContext()
const sessionStore = useSession()
const directory = useContactDirectory()

const id = computed(() => String(route.params.id ?? ''))
const contact = ref<Contact | null>(null)
const gone = ref(false)
const loadError = ref('')
const stats = ref<ContactStats | null>(null)
const saved = ref<ContactVersionEntry[]>([])
const memory = ref<ContactMemoryListing | null>(null)
const experiences = ref<ContactExperienceListing | null>(null)
const capabilityView = ref<ContactCapabilityView | null>(null)
const tab = ref('role')
/** The two versions 版本 compares (null: the previous one, the current one). */
const compareFrom = ref<number | null>(null)
const compareTo = ref<number | null>(null)
let generation = 0

async function loadNumbers(contactId: string, run: number) {
  const [nextStats, nextVersions, nextMemory, nextExperiences, nextCaps] =
    await Promise.all([
      core('contacts.stats', { id: contactId }).catch(() => null),
      core('contacts.versions', { id: contactId }).catch(() => []),
      core('contacts.memory.list', { contactId }).catch(() => null),
      core('contacts.experiences.list', { id: contactId }).catch(() => null),
      core('contacts.capabilities.resolve', { id: contactId }).catch(
        () => null,
      ),
    ])
  if (run !== generation) return
  stats.value = nextStats
  saved.value = Array.isArray(nextVersions) ? nextVersions : []
  memory.value = nextMemory
  experiences.value =
    nextExperiences && Array.isArray(nextExperiences.experiences)
      ? nextExperiences
      : null
  capabilityView.value =
    nextCaps && Array.isArray(nextCaps.skills) ? nextCaps : null
}

async function load() {
  const contactId = id.value
  const run = ++generation
  loadError.value = ''
  gone.value = false
  try {
    const next = await core('contacts.get', { id: contactId })
    if (run !== generation) return
    contact.value = next
  } catch (error) {
    if (run !== generation) return
    contact.value = null
    if ((error as { code?: string }).code === 'contact_not_found')
      gone.value = true
    else loadError.value = failureText(error)
    return
  }
  await loadNumbers(contactId, run)
}

watch(
  id,
  (next, previous) => {
    if (!next) return
    if (next !== previous) {
      tab.value = 'role'
      compareFrom.value = null
      compareTo.value = null
    }
    void load()
  },
  { immediate: true },
)

let reloadTimer: ReturnType<typeof setTimeout> | null = null
const unsubscribe = onCoreEvent((input) => {
  const event = input as { event?: string; contact_id?: string } | null
  const mine =
    event?.event === 'contacts_changed' && event.contact_id === id.value
  if (!mine && event?.event !== 'groups_changed') return
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    if (mine) void load()
    else if (contact.value) void loadNumbers(contact.value.id, generation)
  }, 80)
})
onBeforeUnmount(() => {
  unsubscribe()
  if (reloadTimer) clearTimeout(reloadTimer)
})

// ── header ─────────────────────────────────────────────────────────────
const external = computed(() => contact.value?.kind === 'external')
const introLine = computed(() => {
  const current = contact.value
  if (!current) return ''
  const domains = current.domains.map((domain) => DOMAIN_LABELS[domain])
  return [domains.join('、'), current.intro].filter(Boolean).join(' · ')
})
const opening = ref(false)

async function sendMessage() {
  const current = contact.value
  if (!current || opening.value) return
  opening.value = true
  try {
    const session = (await core('contacts.openChat', {
      id: current.id,
    })) as SessionInfo
    sessionStore.adopt(session)
    // Claude Code and Codex: their chat's delegation, once it has one (GRP-11).
    await router.push(await contactChatLocation(current, session.id))
  } catch (error) {
    ctx.showError(error, '没有打开单聊')
  } finally {
    opening.value = false
  }
}

// ── 拉进群 (GRP-08) ───────────────────────────────────────────────────────
const pullAnchor = ref<HTMLElement | null>(null)
const pulling = ref(false)

function openPull(event: MouseEvent): void {
  pullAnchor.value = event.currentTarget as HTMLElement
  pulling.value = true
}

async function pullInto(groupId: string, title: string): Promise<void> {
  const current = contact.value
  if (!current) return
  try {
    await core('groups.addMember', { id: groupId, contactId: current.id })
    ctx.showToast(`已把「${current.name}」拉进「${title}」`)
    await router.push({ name: 'group', params: { groupId } })
  } catch (error) {
    ctx.showError(error, '没有拉进群')
  }
}

// ── 删除联系人 (GRP-16) ────────────────────────────────────────────────
const moreAnchor = ref<HTMLElement | null>(null)
const moreOpen = ref(false)
const deleting = ref(false)

function openMore(event: MouseEvent): void {
  moreAnchor.value = event.currentTarget as HTMLElement
  moreOpen.value = true
}

async function deleteContact(): Promise<void> {
  const current = contact.value
  if (!current || current.builtin || deleting.value) return
  const confirmed = await confirm({
    title: `删除「${current.name}」？`,
    body: '它的单聊留着，可以查看，不能再发消息；它会退出所在的群，说过的话还留在群里。岗位说明书的历史版本和个人记忆一起删除，不能恢复。',
    confirmLabel: '删除',
    tone: 'danger',
  })
  if (!confirmed) return
  deleting.value = true
  try {
    await core('contacts.delete', { id: current.id })
    ctx.showToast(`已删除「${current.name}」`)
    await router.push({ name: 'contacts' }).catch(() => undefined)
    await directory.refresh()
  } catch (error) {
    ctx.showError(error, '没有删除联系人')
  } finally {
    deleting.value = false
  }
}

function edit() {
  if (!contact.value) return
  void router
    .push({ name: 'contact-edit', params: { id: contact.value.id } })
    .catch(() => undefined)
}

// 换头像 (D21): any avatar of the library; a builtin may change it too.
const pickerOpen = ref(false)
const inUse = computed(() =>
  Object.fromEntries(
    directory.contacts.value
      .filter((item) => item.id !== contact.value?.id)
      .flatMap((item) =>
        item.avatar.kind === 'library'
          ? [[item.avatar.id, item.name] as const]
          : [],
      ),
  ),
)
const libraryId = computed(() =>
  contact.value?.avatar.kind === 'library' ? contact.value.avatar.id : null,
)

async function changeAvatar(avatarId: string) {
  const current = contact.value
  if (!current) return
  try {
    contact.value = await core('contacts.update', {
      id: current.id,
      patch: { avatar: { kind: 'library', id: avatarId } },
    })
  } catch (error) {
    ctx.showError(error, '没有换成头像')
  }
}

// ── the four numbers ───────────────────────────────────────────────────
const rating = computed(() =>
  ratingSummary(stats.value?.ratings ?? { up: 0, down: 0 }),
)
const numbers = computed(() => [
  {
    key: 'groups',
    value: String(stats.value?.groups ?? '—'),
    label: '参与的群',
  },
  {
    key: 'speeches',
    value: String(stats.value?.speeches ?? '—'),
    label: '发言次数',
  },
  {
    key: 'rating',
    value: rating.value.value,
    label: rating.value.label,
    title: rating.value.detail,
  },
  {
    key: 'version',
    value: `v${contact.value?.version ?? stats.value?.version ?? 1}`,
    label: '岗位说明书版本',
  },
])

// ── tabs ───────────────────────────────────────────────────────────────
const TABS = [
  { id: 'role', label: '职责与方法' },
  { id: 'knowledge', label: '知识' },
  { id: 'capabilities', label: '能力' },
  { id: 'memory', label: '记忆' },
  { id: 'versions', label: '版本' },
]

const roleSections = computed(() => {
  const role = contact.value?.role
  if (!role) return []
  return [
    { key: 'mission', label: '职责', text: role.mission },
    { key: 'deliverable', label: '交付', text: role.deliverable },
    { key: 'playbook', label: '工作方法', text: role.playbook },
    { key: 'boundaries', label: '边界', text: role.boundaries },
  ].filter((section) => section.text.trim())
})

function useLabel(use: string): string {
  return use === 'pinned' ? '常驻上下文' : '按需读取'
}

const capabilityRows = computed(() => {
  const current = contact.value
  if (!current) return []
  if (current.kind === 'external')
    return [
      {
        label: '模型与权限',
        value: '跟随「设置 › 子智能体」',
      },
      {
        label: '群聊里发言',
        value: SPEAK_LABELS[current.groupHabit.speak] ?? '',
      },
    ]
  if (current.builtin)
    return [
      { label: '模型与工具', value: '跟随 Emperor 自己的设置' },
      {
        label: '群聊里发言',
        value: SPEAK_LABELS[current.groupHabit.speak] ?? '',
      },
    ]
  const tools = current.capabilities.tools
  return [
    { label: '模型', value: modelLine(current) },
    {
      label: '工具',
      value: [
        PRESET_LABELS[tools.preset] ?? tools.preset,
        tools.allow?.length ? `另加 ${tools.allow.join('、')}` : '',
        tools.deny?.length ? `去掉 ${tools.deny.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    },
    {
      label: '权限',
      value:
        PERMISSION_LABELS[current.capabilities.permission] ??
        current.capabilities.permission,
    },
    {
      label: '群聊里发言',
      value: `${SPEAK_LABELS[current.groupHabit.speak] ?? ''} · ${
        LENGTH_LABELS[current.groupHabit.length] ?? ''
      }`,
    },
  ]
})

// ── 记忆 ────────────────────────────────────────────────────────────────
const editingEntry = ref('')
const entryText = ref('')
const memoryBusy = ref(false)

function beginEdit(entryId: string, text: string) {
  editingEntry.value = entryId
  entryText.value = text
}

async function saveEntry() {
  const current = contact.value
  if (!current || !editingEntry.value || memoryBusy.value) return
  memoryBusy.value = true
  try {
    memory.value = await core('contacts.memory.update', {
      contactId: current.id,
      entryId: editingEntry.value,
      text: entryText.value.trim(),
    })
    editingEntry.value = ''
  } catch (error) {
    ctx.showError(error, '没有改成')
  } finally {
    memoryBusy.value = false
  }
}

async function deleteEntry(entryId: string) {
  const current = contact.value
  if (!current || memoryBusy.value) return
  memoryBusy.value = true
  try {
    memory.value = await core('contacts.memory.delete', {
      contactId: current.id,
      entryId,
    })
  } catch (error) {
    ctx.showError(error, '没有删掉')
  } finally {
    memoryBusy.value = false
  }
}

async function setMemory(enabled: boolean) {
  const current = contact.value
  if (!current) return
  try {
    contact.value = await core('contacts.update', {
      id: current.id,
      patch: { memory: { enabled } },
    })
    memory.value = await core('contacts.memory.list', { contactId: current.id })
  } catch (error) {
    ctx.showError(error, '没有改成')
  }
}

const experienceBusy = ref(false)
const editingExperience = ref('')
const experienceText = ref('')

const EXPERIENCE_STATUS: Readonly<Record<string, string>> = {
  candidate: '待验证',
  active: '有效',
  superseded: '已被替代',
  disabled: '已停用',
  deleted: '已删除',
}
const EXPERIENCE_SCOPE: Readonly<Record<string, string>> = {
  contact: '这个联系人的通用经验',
  project: '项目',
  group: '群聊',
  session: '这段单聊',
}

function experienceStatus(entry: ContactExperience): string {
  return EXPERIENCE_STATUS[entry.status] ?? entry.status
}

function experienceScope(entry: ContactExperience): string {
  const label = EXPERIENCE_SCOPE[entry.scope.kind] ?? entry.scope.kind
  return entry.scope.kind === 'contact'
    ? label
    : `${label} · ${entry.scope.id ?? ''}`
}

async function refreshExperiences(contactId: string): Promise<void> {
  experiences.value = await core('contacts.experiences.list', {
    id: contactId,
  })
}

async function setExperienceStatus(
  entry: ContactExperience,
  status: 'active' | 'disabled' | 'candidate',
): Promise<void> {
  const current = contact.value
  if (!current || experienceBusy.value) return
  experienceBusy.value = true
  try {
    await core('contacts.experiences.setStatus', {
      id: current.id,
      experienceId: entry.id,
      status,
    })
    await refreshExperiences(current.id)
  } catch (error) {
    ctx.showError(error, '没有改成')
  } finally {
    experienceBusy.value = false
  }
}

async function removeExperience(entry: ContactExperience): Promise<void> {
  const current = contact.value
  if (!current || experienceBusy.value) return
  const ok = await confirm({
    title: '删除这条经验？',
    body: '它不会再被召回；恢复后会先回到待验证。',
    confirmLabel: '删除',
    tone: 'danger',
  })
  if (!ok) return
  experienceBusy.value = true
  try {
    await core('contacts.experiences.remove', {
      id: current.id,
      experienceId: entry.id,
    })
    await refreshExperiences(current.id)
  } catch (error) {
    ctx.showError(error, '没有删掉')
  } finally {
    experienceBusy.value = false
  }
}

async function restoreExperience(entry: ContactExperience): Promise<void> {
  const current = contact.value
  if (!current || experienceBusy.value) return
  experienceBusy.value = true
  try {
    await core('contacts.experiences.restore', {
      id: current.id,
      experienceId: entry.id,
    })
    await refreshExperiences(current.id)
  } catch (error) {
    ctx.showError(error, '没有恢复')
  } finally {
    experienceBusy.value = false
  }
}

function beginExperienceEdit(entry: ContactExperience): void {
  editingExperience.value = entry.id
  experienceText.value = entry.text
}

async function saveExperience(): Promise<void> {
  const current = contact.value
  if (!current || !editingExperience.value || experienceBusy.value) return
  experienceBusy.value = true
  try {
    await core('contacts.experiences.update', {
      id: current.id,
      experienceId: editingExperience.value,
      patch: { text: experienceText.value.trim() },
    })
    editingExperience.value = ''
    await refreshExperiences(current.id)
  } catch (error) {
    ctx.showError(error, '没有改成')
  } finally {
    experienceBusy.value = false
  }
}

// ── 版本 ────────────────────────────────────────────────────────────────
const versions = computed(() =>
  contact.value ? profileVersions(contact.value, saved.value) : [],
)
const fromVersion = computed(
  () =>
    versions.value.find((row) => row.version === compareFrom.value) ??
    versions.value[1] ??
    null,
)
const toVersion = computed(
  () =>
    versions.value.find((row) => row.version === compareTo.value) ??
    versions.value[0] ??
    null,
)
const versionOptions = computed(() =>
  versions.value.map((row) => ({
    value: row.version,
    label: row.current ? `v${row.version}（当前）` : `v${row.version}`,
  })),
)
const changes = computed(() => {
  const from = fromVersion.value
  const to = toVersion.value
  if (!from || !to || from.version === to.version) return []
  const [older, newer] = from.version < to.version ? [from, to] : [to, from]
  return versionChanges(older.contact, newer.contact)
})
const restoring = ref(false)

function savedAt(time: number): string {
  if (!time) return ''
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(
    date.getHours(),
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function compareWith(version: number) {
  compareFrom.value = version
  compareTo.value = versions.value[0]?.version ?? null
}

async function restore(version: number) {
  const current = contact.value
  if (!current || restoring.value) return
  const confirmed = await confirm({
    title: `退回到 v${version}？`,
    body: `岗位说明书会变回 v${version} 的样子，存成一个新版本；现在的 v${current.version} 留在历史里，随时可以再退回来。`,
    confirmLabel: '退回',
  })
  if (!confirmed) return
  restoring.value = true
  try {
    const next = await core('contacts.restoreVersion', {
      id: current.id,
      version,
    })
    contact.value = next
    compareFrom.value = null
    compareTo.value = null
    ctx.showToast(`已退回到 v${version}（存为 v${next.version}）`)
    await loadNumbers(next.id, generation)
  } catch (error) {
    ctx.showError(error, '没有退回')
  } finally {
    restoring.value = false
  }
}

function backHome() {
  void router.push({ name: 'contacts' }).catch(() => undefined)
}
</script>

<template>
  <div
    class="contact-profile"
    :data-embedded="props.embedded || undefined"
    data-contact-profile
  >
    <header class="bar">
      <span class="crumb">联系人</span>
      <span v-if="contact" class="crumb-current">/ {{ contact.name }}</span>
    </header>

    <div class="scroll">
      <EmptyState
        v-if="gone"
        title="这个联系人已删除"
        description="它的单聊还在，可以查看，不能再发消息；群里的历史消息也都留着。"
      >
        <Button size="sm" @click="backHome">回到联系人列表</Button>
      </EmptyState>
      <Notice
        v-else-if="loadError"
        tone="error"
        title="联系人没有打开"
        :description="loadError"
      />

      <div v-else-if="contact" class="profile">
        <div class="head">
          <span class="portrait">
            <Avatar
              v-bind="contactAvatarProps(contact.avatar, contact.name)"
              :size="
                contact.avatar.kind === 'library' ||
                contact.avatar.kind === 'mascot'
                  ? 56
                  : 40
              "
              labelled
            />
          </span>
          <div class="who">
            <h1 class="name">{{ contact.name }}</h1>
            <p class="intro" data-profile-intro>{{ introLine }}</p>
            <Button
              v-if="!external"
              size="sm"
              class="change-avatar"
              @click="pickerOpen = true"
              >换头像</Button
            >
          </div>
          <div class="actions">
            <Button
              size="sm"
              variant="primary"
              :loading="opening"
              @click="sendMessage"
              >发消息</Button
            >
            <Button size="sm" variant="secondary" @click="openPull"
              >拉进群</Button
            >
            <Menu
              v-model:open="pulling"
              :anchor="pullAnchor"
              placement="bottom"
              label="拉进群"
              dense
            >
              <MenuItem
                v-for="group in directory.groups.value"
                :key="group.id"
                :description="`${group.memberCount} 人`"
                @select="pullInto(group.id, group.title)"
                >{{ group.title }}</MenuItem
              >
              <MenuItem v-if="!directory.groups.value.length" disabled
                >还没有群聊</MenuItem
              >
            </Menu>
            <Button size="sm" @click="edit">编辑</Button>
            <template v-if="!contact.builtin">
              <IconButton
                label="更多操作"
                :active="moreOpen"
                aria-haspopup="menu"
                :aria-expanded="moreOpen"
                data-contact-more
                @click="openMore"
              >
                <DsMore :size="16" />
              </IconButton>
              <Menu
                v-model:open="moreOpen"
                :anchor="moreAnchor"
                placement="bottom"
                label="更多操作"
                dense
              >
                <MenuItem
                  danger
                  :disabled="deleting"
                  data-delete-contact
                  @select="deleteContact"
                  >删除联系人</MenuItem
                >
              </Menu>
            </template>
          </div>
        </div>
        <p v-if="external" class="note">{{ EXTERNAL_CHAT_NOTE }}</p>

        <div class="stats">
          <Surface
            v-for="item in numbers"
            :key="item.key"
            pad="sm"
            class="stat"
            :title="item.title"
            :data-stat="item.key"
          >
            <b class="stat-value">{{ item.value }}</b>
            <span class="stat-label">{{ item.label }}</span>
          </Surface>
        </div>

        <Tabs v-model="tab" :tabs="TABS" aria-label="联系人档案" />

        <section v-if="tab === 'role'" class="panel" data-tab="role">
          <p v-if="contact.builtin && !external" class="hint">
            Emperor 的岗位说明书就是它的人设，随应用更新，不能在这里改。
          </p>
          <p v-else-if="external" class="hint">
            外部联系人可以套一份岗位说明书（例如「Claude Code ·
            安全审计」），由它自己的追加指令生效。
          </p>
          <template v-if="!contact.builtin">
            <div
              v-for="section in roleSections"
              :key="section.key"
              class="role-section"
            >
              <h2 class="section-title">{{ section.label }}</h2>
              <p class="prose">{{ section.text }}</p>
            </div>
            <p v-if="!roleSections.length" class="hint">
              还没有写岗位说明书：点「编辑」补上职责、交付、工作方法和边界。
            </p>
          </template>
        </section>

        <section
          v-else-if="tab === 'knowledge'"
          class="panel"
          data-tab="knowledge"
        >
          <p class="hint">
            只读资料：工作时要用的文件、文件夹、网址和笔记。常驻的资料会放进每一次提示词；其余按需读取。
          </p>
          <Surface
            v-for="item in contact.knowledge ?? []"
            :key="item.id"
            pad="sm"
            class="line-item"
          >
            <span>{{ knowledgeLine(item) }}</span>
            <span class="hint">{{ useLabel(item.use) }}</span>
          </Surface>
          <p v-if="!(contact.knowledge ?? []).length" class="hint">
            还没有知识：在「编辑」里加文件、文件夹、网址或笔记。
          </p>
          <Button size="sm" @click="edit">添加资料</Button>
        </section>

        <section
          v-else-if="tab === 'capabilities'"
          class="panel"
          data-tab="capabilities"
        >
          <dl class="kv">
            <template v-for="row in capabilityRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </template>
          </dl>
          <template v-if="contact.kind === 'external'">
            <p class="hint">
              外部智能体（Claude Code、Codex）暂不支持在 Emperor 里绑定 Skill 或
              MCP；它们在群里只读、只在被 @ 时发言。
            </p>
          </template>
          <template v-else-if="!contact.builtin && capabilityView">
            <h4 class="cap-title">工作技能</h4>
            <p v-if="!capabilityView.skills.length" class="hint">
              还没有选 Skill：在「编辑 › 能力」里从当前可用的 Skill 里选。
            </p>
            <Surface
              v-for="skill in capabilityView.skills"
              :key="skill.id"
              pad="sm"
              class="line-item"
              :data-skill="skill.name"
            >
              <span>{{ skill.name }}</span>
              <span class="hint">{{
                skill.available ? '可用' : skill.reason
              }}</span>
            </Surface>
            <h4 class="cap-title">外部连接</h4>
            <p v-if="!capabilityView.mcp.length" class="hint">
              还没有连接 MCP：在「编辑 › 能力」里选已配置的服务和工具。
            </p>
            <Surface
              v-for="server in capabilityView.mcp"
              :key="server.serverId"
              pad="sm"
              class="line-item"
              :data-mcp="server.serverId"
            >
              <span>{{ server.serverId }}</span>
              <span class="hint">{{
                server.available ? '已连接' : server.reason
              }}</span>
              <span class="hint">
                {{ server.tools.map((tool) => tool.name).join('、') }}
              </span>
            </Surface>
          </template>
        </section>

        <section v-else-if="tab === 'memory'" class="panel" data-tab="memory">
          <div class="memory-switch">
            <Switch
              :model-value="contact.memory.enabled"
              :disabled="contact.builtin"
              aria-label="个人记忆"
              @change="setMemory"
            />
            <span>
              记忆{{ contact.memory.enabled ? '开着' : '关着' }}：{{
                contact.name
              }}从自己的工作里整理出的经验，以及你给的 👍 /
              👎。只对它自己生效；推测先待验证，不参与回答。
            </span>
          </div>
          <div class="experience-block" data-experiences>
            <h4 class="cap-title">工作经验</h4>
            <p v-if="experiences?.lastError" class="hint warn">
              上次整理没有完成：{{ experiences.lastError.message }}
            </p>
            <p v-if="!experiences?.experiences?.length" class="hint">
              还没有经验：一项工作结束后，有工具结果或你的确认 /
              纠正时自动整理。
            </p>
            <Surface
              v-for="entry in experiences?.experiences ?? []"
              :key="entry.id"
              pad="sm"
              class="memory-entry"
              :data-experience="entry.id"
              :data-status="entry.status"
            >
              <template v-if="editingExperience === entry.id">
                <div class="memory-edit" data-experience-edit>
                  <TextField
                    v-model="experienceText"
                    size="sm"
                    aria-label="这条经验"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    :loading="experienceBusy"
                    @click="saveExperience"
                    >保存</Button
                  >
                  <Button size="sm" @click="editingExperience = ''"
                    >取消</Button
                  >
                </div>
              </template>
              <template v-else>
                <span class="memory-text">{{ entry.text }}</span>
                <span class="experience-meta">
                  {{ experienceStatus(entry) }} · {{ experienceScope(entry) }}
                  <template v-if="entry.conditions">
                    · 适用：{{ entry.conditions }}</template
                  >
                  · 来源：{{ entry.source.sessionId.slice(0, 8) }} · 第
                  {{ entry.source.turnId }} 轮
                </span>
                <span class="memory-actions">
                  <Button size="sm" @click="beginExperienceEdit(entry)"
                    >改</Button
                  >
                  <Button
                    v-if="entry.status === 'active'"
                    size="sm"
                    @click="setExperienceStatus(entry, 'disabled')"
                    >停用</Button
                  >
                  <Button
                    v-else-if="entry.status === 'disabled'"
                    size="sm"
                    @click="setExperienceStatus(entry, 'active')"
                    >启用</Button
                  >
                  <Button
                    v-if="entry.status !== 'deleted'"
                    size="sm"
                    @click="removeExperience(entry)"
                    >删除</Button
                  >
                  <Button v-else size="sm" @click="restoreExperience(entry)"
                    >恢复</Button
                  >
                </span>
              </template>
            </Surface>
            <template v-if="experiences?.legacy?.length">
              <h4 class="cap-title">历史反馈（待确认）</h4>
              <p class="hint">
                这些旧反馈没有可追溯的来源，不会自动用于回答；确认结论和范围前只在这里保留原文。
              </p>
              <Surface
                v-for="entry in experiences.legacy"
                :key="entry.id"
                pad="sm"
                class="line-item"
                data-legacy-feedback
              >
                {{ entry.rawText }}
              </Surface>
            </template>
            <h4 class="cap-title">你的反馈</h4>
          </div>
          <p v-if="memory?.notice" class="hint warn">{{ memory.notice }}</p>
          <Surface
            v-for="entry in memory?.entries ?? []"
            :key="entry.id"
            pad="sm"
            class="memory-entry"
            :data-memory-entry="entry.id"
          >
            <template v-if="editingEntry === entry.id">
              <div class="memory-edit" data-memory-edit>
                <TextField
                  v-model="entryText"
                  size="sm"
                  aria-label="这条记忆"
                />
                <Button
                  size="sm"
                  variant="primary"
                  :loading="memoryBusy"
                  @click="saveEntry"
                  >保存</Button
                >
                <Button size="sm" @click="editingEntry = ''">取消</Button>
              </div>
            </template>
            <template v-else>
              <span class="memory-text">{{ entry.text }}</span>
              <span class="memory-actions">
                <Button size="sm" @click="beginEdit(entry.id, entry.text)"
                  >改</Button
                >
                <Button size="sm" @click="deleteEntry(entry.id)">删除</Button>
              </span>
            </template>
          </Surface>
          <p v-if="memory && !memory.entries.length" class="hint">
            还没有记忆：在单聊里给它的回答点 👍 或 👎，写一句为什么。
          </p>
        </section>

        <section v-else class="panel" data-tab="versions">
          <p class="hint">
            每次保存岗位说明书都会生成新版本（只换头像不算）；群里永远用最新版。
          </p>
          <Surface
            v-for="row in versions"
            :key="row.version"
            pad="sm"
            class="version-row"
            :data-version-row="row.version"
          >
            <span class="version-name">
              v{{ row.version }}{{ row.current ? ' · 当前' : '' }}
            </span>
            <span class="version-time">{{ savedAt(row.savedAt) }}</span>
            <Button
              v-if="!row.current"
              size="sm"
              data-compare
              @click="compareWith(row.version)"
              >和当前对比</Button
            >
          </Surface>
          <p v-if="versions.length < 2" class="hint">还只有这一个版本。</p>
          <Surface
            v-if="fromVersion && toVersion && versions.length > 1"
            pad="md"
            class="diff"
            data-version-diff
          >
            <div class="diff-head">
              <Select
                :model-value="fromVersion.version"
                :options="versionOptions"
                size="sm"
                aria-label="从哪个版本"
                @change="compareFrom = Number($event)"
              />
              <span>→</span>
              <Select
                :model-value="toVersion.version"
                :options="versionOptions"
                size="sm"
                aria-label="到哪个版本"
                @change="compareTo = Number($event)"
              />
              <span class="diff-title"
                >v{{ fromVersion.version }} → v{{ toVersion.version }}</span
              >
              <Button
                v-if="!fromVersion.current"
                size="sm"
                variant="secondary"
                :loading="restoring"
                @click="restore(fromVersion.version)"
                >退回到 v{{ fromVersion.version }}</Button
              >
            </div>
            <div v-for="change in changes" :key="change.key" class="change">
              <span class="change-label">{{ change.label }}</span>
              <span class="change-before">{{ change.before || '（空）' }}</span>
              <span class="change-after">{{ change.after || '（空）' }}</span>
            </div>
            <p v-if="!changes.length" class="hint">这两个版本没有不同。</p>
          </Surface>
        </section>
      </div>
    </div>

    <AvatarLibraryPicker
      v-if="contact && !external"
      v-model:open="pickerOpen"
      :selected="libraryId"
      :in-use="inUse"
      @select="changeAvatar"
    />
  </div>
</template>

<style scoped>
.contact-profile {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.contact-profile[data-embedded] {
  height: auto;
  min-height: 0;
  flex: none;
  background: transparent;
}

.contact-profile[data-embedded] .bar {
  display: none;
}

.contact-profile[data-embedded] .scroll {
  padding: 0;
  overflow: visible;
}

.contact-profile[data-embedded] .profile {
  max-width: none;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 50px;
  padding: var(--space-2-5) var(--space-5);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.crumb {
  font-weight: var(--weight-semibold);
}

.crumb-current {
  color: rgb(var(--text-3));
}

.scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-8);
  overflow-y: auto;
}

.profile {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 760px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
}

.portrait {
  display: inline-flex;
  border-radius: var(--r-full);
}

.who {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  min-width: 0;
}

.name {
  margin: 0;
  font-size: var(--fs-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
}

.intro {
  margin: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.change-avatar {
  margin-left: calc(0px - var(--space-2));
}

.actions {
  display: flex;
  gap: var(--space-1-5);
}

.actions [aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}

.note,
.hint {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.hint.warn {
  color: rgb(var(--attention));
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2-5);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.stat-value {
  font-size: var(--fs-md);
  line-height: var(--lh-md);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.role-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.section-title {
  margin: 0;
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.prose {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cap-title {
  margin: var(--space-4) 0 var(--space-1);
  color: rgb(var(--text-1));
  font-size: var(--fs-xs);
  font-weight: var(--weight-semibold);
}

.experience-meta {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxxs);
  line-height: var(--lh-xxxs);
}

.line-item {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  overflow-wrap: anywhere;
}

.kv {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.kv dt {
  color: rgb(var(--text-3));
}

.kv dd {
  margin: 0;
}

.memory-switch {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.memory-entry,
.version-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-s);
  line-height: var(--lh-s);
}

.memory-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.memory-actions {
  display: flex;
  flex: none;
  gap: var(--space-1);
}

.memory-edit {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-1-5);
}

.version-name {
  font-weight: var(--weight-medium);
}

.version-time {
  flex: 1;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.diff {
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
}

.diff-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.diff-title {
  flex: 1;
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.change {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-2);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.change-label {
  color: rgb(var(--text-3));
}

.change-before,
.change-after {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--r-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.change-before {
  background: rgb(var(--error-soft));
}

.change-after {
  background: rgb(var(--ok-soft));
}

@media (max-width: 720px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .change {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
