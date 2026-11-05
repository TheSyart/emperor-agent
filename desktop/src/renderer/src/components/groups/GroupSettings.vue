<script setup lang="ts">
/**
 * GroupSettings — 群设置, `/groups/:groupId/settings` (GRP-08, 预览 B 第 5
 * 步): the name; the announcement every member reads before speaking
 * (群公告, saved with 「保存公告」); the
 * members work autonomously in separate directories; then 每轮结束时群聊出结论,
 * 防打转 and 安静模式, each saved at once (预览 B 第 5 步's order); then
 * the members; the group's files; last, 删除群聊 (GRP-16).
 * Every change goes to `groups.update` (members: addMember / removeMember)
 * and shows what Core returns; a change that fails says so and goes back.
 * 删除群聊 asks first, then `groups.delete` moves the group and its members'
 * sessions to 最近删除 (restorable for 30 days) and the Group home opens.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ROLE_CREATOR_CONTACT_ID } from '@emperor/core/runtime-contract'
import { ChevronLeft } from 'lucide-vue-next'
import { core } from '../../api/http'
import { confirm } from '../ui/confirm'
import { useAppContext } from '../../composables/useAppContext'
import { contactAvatarProps } from '../contacts/contactAvatar'
import { useContactDirectory } from '../contacts/contactDirectory'
import Avatar from '../ui/Avatar.vue'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import Field from '../ui/Field.vue'
import IconButton from '../ui/IconButton.vue'
import Menu from '../ui/Menu.vue'
import MenuItem from '../ui/MenuItem.vue'
import Notice from '../ui/Notice.vue'
import Switch from '../ui/Switch.vue'
import TextArea from '../ui/TextArea.vue'
import TextField from '../ui/TextField.vue'
import type { GroupView } from './groupModel'
import { GROUP_MEMBER_LIMIT, GROUP_TITLE_LIMIT } from './newGroupModel'

type Settings = GroupView['settings']
type Patch = {
  title?: string
  charter?: string
  settings?: Partial<Settings>
}

const route = useRoute()
const router = useRouter()
const ctx = useAppContext()
const directory = useContactDirectory()

const groupId = computed(() => String(route.params.groupId ?? ''))
const group = ref<GroupView | null>(null)
const gone = ref(false)
const loadError = ref('')
const title = ref('')
const charter = ref('')
const files = ref<{ name: string; dir: boolean }[]>([])
let generation = 0

async function load(): Promise<void> {
  const id = groupId.value
  const run = ++generation
  try {
    const view = await core('groups.get', { id })
    if (run !== generation) return
    adopt(view)
    gone.value = false
    loadError.value = ''
  } catch (error) {
    if (run !== generation) return
    group.value = null
    if ((error as { code?: string }).code === 'group_not_found')
      gone.value = true
    else
      loadError.value = error instanceof Error ? error.message : String(error)
    return
  }
  try {
    const listed = await core('groups.files.list', { id })
    if (run === generation) files.value = listed.files
  } catch {
    files.value = []
  }
}

function adopt(view: GroupView): void {
  group.value = view
  title.value = view.title
  charter.value = view.charter
}

watch(groupId, (id) => id && void load(), { immediate: true })

async function save(patch: Patch, fallback: string): Promise<void> {
  const current = group.value
  if (!current) return
  try {
    adopt(await core('groups.update', { id: current.id, patch }))
  } catch (error) {
    ctx.showError(error, fallback)
    adopt(current)
  }
}

const settings = computed<Settings | null>(() => group.value?.settings ?? null)

function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  if (!settings.value || settings.value[key] === value) return
  void save({ settings: { [key]: value } as Partial<Settings> }, '设置没有保存')
}

function saveTitle(): void {
  const next = title.value.trim()
  if (!group.value || next === group.value.title) return
  if (!next) {
    title.value = group.value.title
    return
  }
  void save({ title: next }, '群名没有保存')
}

const charterChanged = computed(
  () => Boolean(group.value) && charter.value.trim() !== group.value!.charter,
)
function saveCharter(): void {
  if (charterChanged.value)
    void save({ charter: charter.value.trim() }, '群公告没有保存')
}

// ── members ─────────────────────────────────────────────────────────────
function avatarOf(id: string, name: string) {
  const contact = directory.find(id)
  return contact
    ? contactAvatarProps(contact.avatar, contact.name)
    : { kind: 'initials' as const, label: name }
}
const addable = computed(() =>
  directory.contacts.value.filter(
    (contact) =>
      contact.id !== ROLE_CREATOR_CONTACT_ID &&
      !group.value?.members.some((member) => member.id === contact.id),
  ),
)
const inviteAnchor = ref<HTMLElement | null>(null)
const inviting = ref(false)
function openInvite(event: MouseEvent): void {
  inviteAnchor.value = event.currentTarget as HTMLElement
  inviting.value = true
}
async function invite(contactId: string): Promise<void> {
  if (!group.value) return
  try {
    adopt(await core('groups.addMember', { id: group.value.id, contactId }))
  } catch (error) {
    ctx.showError(error, '没有邀请成功')
  }
}
async function remove(contactId: string): Promise<void> {
  if (!group.value) return
  try {
    adopt(await core('groups.removeMember', { id: group.value.id, contactId }))
  } catch (error) {
    ctx.showError(error, '没有移出')
  }
}

const SWITCHES: {
  key: 'summarizeAtEnd' | 'loopGuard' | 'quiet'
  title: string
  text: string
}[] = [
  {
    key: 'summarizeAtEnd',
    title: '每轮结束时群聊出结论',
    text: '结论用浅金底显示，交回给你。',
  },
  {
    key: 'loopGuard',
    title: '防打转',
    text: '两人来回、观点不再变化时，群聊介入换人或收尾。这不是额度，不限次数。',
  },
  {
    key: 'quiet',
    title: '安静模式',
    text: '只回应 @：没人被 @ 就没人说话。适合只想点名问的群。',
  },
]

// ── 删除群聊 (GRP-16) ─────────────────────────────────────────────────
const deleting = ref(false)

async function deleteGroup(): Promise<void> {
  const current = group.value
  if (!current || deleting.value) return
  const confirmed = await confirm({
    title: `删除「${current.title}」？`,
    body: '群聊和每位成员的工作过程一起移到「设置 › 常规 › 已归档对话 › 最近删除」，30 天内可以恢复，之后自动清除。进行中的一轮会先停下。',
    confirmLabel: '删除',
    tone: 'danger',
  })
  if (!confirmed) return
  deleting.value = true
  try {
    await core('groups.delete', { id: current.id })
    ctx.showToast(
      `已删除「${current.title}」，可以在「设置 › 常规 › 已归档对话」里恢复`,
    )
    await router.push({ name: 'groups' }).catch(() => undefined)
    await directory.refresh()
  } catch (error) {
    ctx.showError(error, '没有删除群聊')
  } finally {
    deleting.value = false
  }
}

function back(): void {
  void router
    .push({ name: 'group', params: { groupId: groupId.value } })
    .catch(() => undefined)
}
</script>

<template>
  <div class="group-settings" data-group-settings>
    <header class="head">
      <IconButton label="回到群聊" @click="back">
        <ChevronLeft :size="16" />
      </IconButton>
      <h1 class="title">群设置</h1>
      <span v-if="group" class="muted">/ {{ group.title }}</span>
    </header>
    <div class="scroll">
      <EmptyState
        v-if="gone"
        title="没有找到这个群"
        description="它可能已被删除。"
      />
      <Notice
        v-else-if="loadError"
        tone="error"
        title="群设置没有打开"
        :description="loadError"
      />
      <div v-else-if="group && settings" class="form">
        <section class="block">
          <Field label="群名" data-group-title>
            <TextField
              v-model="title"
              :maxlength="GROUP_TITLE_LIMIT"
              @change="saveTitle"
              @keydown.enter="saveTitle"
            />
          </Field>
        </section>

        <section class="block">
          <h2 class="block-title">
            群公告 <small>每位成员发言前都会读到</small>
          </h2>
          <Field data-charter>
            <TextArea
              v-model="charter"
              :min-rows="3"
              :max-rows="12"
              placeholder="目标、约束，例如：只讨论设计，不改代码；有分歧时列出两边理由，由我决定。"
            />
          </Field>
          <div class="row-end">
            <Button
              size="sm"
              variant="secondary"
              data-save-charter
              :disabled="!charterChanged"
              @click="saveCharter"
              >保存公告</Button
            >
          </div>
        </section>

        <section
          v-for="item in SWITCHES"
          :key="item.key"
          class="switch-row"
          :data-setting="item.key"
        >
          <Switch
            :model-value="settings[item.key]"
            :aria-label="item.title"
            @update:model-value="setSetting(item.key, $event)"
          />
          <span class="switch-text">
            <b>{{ item.title }}</b>
            <span>{{ item.text }}</span>
          </span>
        </section>

        <section class="block">
          <h2 class="block-title">
            成员 {{ group.members.length }}
            <Button
              size="sm"
              class="invite"
              :disabled="
                !addable.length || group.members.length >= GROUP_MEMBER_LIMIT
              "
              @click="openInvite"
              >+ 邀请</Button
            >
          </h2>
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
              @select="invite(contact.id)"
              >{{ contact.name }}</MenuItem
            >
          </Menu>
          <ul class="members">
            <li
              v-for="member in group.members"
              :key="member.id"
              class="member"
              :data-settings-member="member.id"
            >
              <Avatar v-bind="avatarOf(member.id, member.name)" :size="24" />
              <span class="member-name">{{
                member.missing ? '已删除的联系人' : member.name
              }}</span>
              <span class="member-role">{{
                member.external ? '外部' : member.intro
              }}</span>
              <Button size="sm" data-remove-member @click="remove(member.id)"
                >移出</Button
              >
            </li>
          </ul>
        </section>

        <section class="block">
          <h2 class="block-title">
            群文件 <small>成员交办时可以写在这里</small>
          </h2>
          <p v-if="!files.length" class="hint">还没有群文件。</p>
          <ul v-else class="files">
            <li v-for="file in files" :key="file.name">
              {{ file.name }}{{ file.dir ? '/' : '' }}
            </li>
          </ul>
        </section>

        <section class="block danger-zone" data-danger-zone>
          <div class="danger-text">
            <h2 class="block-title">删除群聊</h2>
            <p class="hint">
              群聊和成员的工作过程移到「最近删除」，30 天内可以恢复。
            </p>
          </div>
          <Button
            size="sm"
            variant="danger"
            :loading="deleting"
            data-delete-group
            @click="deleteGroup"
            >删除群聊</Button
          >
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.group-settings {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: rgb(var(--surface-base));
  color: rgb(var(--text-1));
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 50px;
  padding: var(--space-2-5) var(--space-4);
  box-shadow: inset 0 -0.5px 0 var(--hairline);
}

.title {
  margin: 0;
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: var(--weight-semibold);
}

.muted {
  color: rgb(var(--text-3));
  font-size: var(--fs-xs);
}

.scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-6) var(--space-8);
  overflow-y: auto;
}

.form {
  display: grid;
  gap: var(--space-3-5);
  max-width: 720px;
}

.block {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3-5);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.block-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  font-weight: var(--weight-semibold);
}

.block-title small {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  font-weight: var(--weight-regular);
}

.invite {
  margin-left: auto;
}

.row-end {
  display: flex;
  justify-content: flex-end;
}

.members,
.files {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.member {
  display: grid;
  grid-template-columns: 24px auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-xs);
}

.member-role {
  overflow: hidden;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 0;
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.switch-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-md);
  background: rgb(var(--surface-raised));
  box-shadow: 0 0 0 0.5px var(--hairline);
}

.switch-text {
  display: grid;
  gap: var(--space-0-5);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
}

.switch-text b {
  font-weight: var(--weight-medium);
}

.switch-text span {
  color: rgb(var(--text-3));
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
}

.files li {
  font-size: var(--fs-xs);
}

.danger-zone {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.danger-text {
  display: grid;
  gap: var(--space-0-5);
}
</style>
