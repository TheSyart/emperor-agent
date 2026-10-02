<script setup lang="ts">
/**
 * 设置 › 浏览器 › 登录状态 — the browser profiles Emperor opens pages in
 * when it operates the built-in browser (`computerUse.listProfiles`): the
 * temporary one keeps nothing; a persistent one keeps its sites' cookies
 * and sign-ins. 新建 (header) and 重命名 open a dialog; 清空 and 删除 ask
 * first, close the profile's tabs and revoke the site permissions tied to
 * it. The user's own browsing (the 浏览器 pane) never uses these.
 */
import type { BrowserProfileView } from '@emperor/core/runtime-contract'
import { Plus } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { core } from '../../../api/http'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { useSettingsHeader } from '../settingsHeader'
import {
  EmptyState,
  Field,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  TextField,
} from '../ui'

const profiles = ref<BrowserProfileView[]>([])
const busy = ref(false)
const error = ref('')
/** The name dialog: a new profile, or the one being renamed. */
const dialog = ref<{ profile: BrowserProfileView | null } | null>(null)
const name = ref('')

const persistent = computed(() =>
  profiles.value.filter((profile) => profile.kind === 'persistent'),
)
const temporary = computed(() =>
  profiles.value.filter((profile) => profile.kind === 'temporary'),
)

async function reload(): Promise<void> {
  profiles.value = await core('computerUse.listProfiles')
}

async function run(action: () => Promise<unknown>): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  error.value = ''
  try {
    await action()
    await reload()
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    return false
  } finally {
    busy.value = false
  }
}

function openDialog(profile: BrowserProfileView | null): void {
  error.value = ''
  name.value = profile?.name ?? ''
  dialog.value = { profile }
}

function onDialogOpen(open: boolean): void {
  if (!open) dialog.value = null
}

async function submit(): Promise<void> {
  const target = dialog.value
  const next = name.value.trim()
  if (!target || !next) return
  const saved = await run(() =>
    target.profile
      ? core('computerUse.manageProfile', {
          action: 'rename',
          profileId: target.profile.profileId,
          name: next,
        })
      : core('computerUse.manageProfile', { action: 'create', name: next }),
  )
  if (saved) dialog.value = null
}

function clear(profile: BrowserProfileView, remove: boolean): void {
  if (
    !window.confirm(
      remove
        ? `删除「${profile.name}」及其浏览数据，并撤销关联授权？`
        : `清空「${profile.name}」的浏览数据，并撤销关联授权？`,
    )
  )
    return
  void run(() =>
    core('computerUse.manageProfile', {
      action: remove ? 'delete' : 'clear',
      profileId: profile.profileId,
    }),
  )
}

function tabs(profile: BrowserProfileView): string {
  return profile.openTargets
    ? `${profile.openTargets} 个打开的标签页`
    : '没有打开的标签页'
}

useSettingsHeader({
  actions: () => [
    {
      id: 'new-profile',
      label: '新建',
      kind: 'primary',
      icon: Plus,
      onClick: () => openDialog(null),
    },
  ],
})

onMounted(() => {
  void reload().catch((cause) => {
    error.value = cause instanceof Error ? cause.message : String(cause)
  })
})
</script>

<template>
  <SettingsSection
    intro="Emperor 操作网页时用这些 profile，持久的会保留网站登录。"
  >
    <SettingsNotice v-if="error && !dialog" tone="error" :title="error" />
    <SettingsGroup title="持久 profile">
      <EmptyState
        v-if="!persistent.length"
        compact
        title="还没有持久 profile"
        description="点右上角的「新建」创建一个，或从 Chrome 导入登录。"
      />
      <SettingsRow
        v-for="profile in persistent"
        :key="profile.profileId"
        :title="profile.name"
        :description="tabs(profile)"
        :data-profile="profile.profileId"
        dense
      >
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="openDialog(profile)"
          >重命名</Button
        >
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="clear(profile, false)"
          >清空</Button
        >
        <Button
          size="sm"
          variant="danger"
          :disabled="busy"
          @click="clear(profile, true)"
          >删除</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup v-if="temporary.length" title="临时 profile">
      <SettingsRow
        v-for="profile in temporary"
        :key="profile.profileId"
        :title="profile.name"
        :description="`不保留登录 · ${tabs(profile)}`"
        :data-profile="profile.profileId"
        dense
      />
    </SettingsGroup>
    <Modal
      :open="dialog !== null"
      :title="dialog?.profile ? '重命名 profile' : '新建 profile'"
      @update:open="onDialogOpen"
    >
      <form id="profile-form" class="profile-form" @submit.prevent="submit">
        <SettingsNotice v-if="error" tone="error" :title="error" />
        <Field label="名称">
          <TextField v-model="name" required :maxlength="60" />
        </Field>
      </form>
      <template #footer>
        <Button variant="outline" type="button" @click="dialog = null"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="profile-form"
          :disabled="busy || !name.trim()"
          >{{ dialog?.profile ? '保存' : '新建' }}</Button
        >
      </template>
    </Modal>
  </SettingsSection>
</template>

<style scoped>
.profile-form {
  display: grid;
  gap: var(--space-3);
}
</style>
