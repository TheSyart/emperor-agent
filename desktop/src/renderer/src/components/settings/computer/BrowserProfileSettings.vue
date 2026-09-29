<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type {
  BrowserProfileView,
  SitePermission,
  SitePermissionKind,
} from '@emperor/core/runtime-contract'
import { core } from '../../../api/http'
import Button from '../../ui/Button.vue'
import { SettingsGroup, SettingsRow } from '../ui'

const profiles = ref<BrowserProfileView[]>([])
const permissions = ref<SitePermission[]>([])
const name = ref('')
const profileId = ref('temporary')
const origin = ref('')
const kind = ref<SitePermissionKind>('notifications')
const minutes = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
const kinds: { value: SitePermissionKind; label: string }[] = [
  { value: 'camera', label: '摄像头' },
  { value: 'microphone', label: '麦克风' },
  { value: 'geolocation', label: '位置' },
  { value: 'notifications', label: '通知' },
  { value: 'clipboard-read', label: '读取剪贴板' },
  { value: 'clipboard-write', label: '写入剪贴板' },
  { value: 'fullscreen', label: '全屏' },
]

async function reload(): Promise<void> {
  ;[profiles.value, permissions.value] = await Promise.all([
    core('computerUse.listProfiles'),
    core('computerUse.listSitePermissions'),
  ])
}

async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function create(): void {
  void run(async () => {
    await core('computerUse.manageProfile', {
      action: 'create',
      name: name.value.trim(),
    })
    name.value = ''
  })
}

function rename(profile: BrowserProfileView): void {
  const next = window.prompt('新的 profile 名称', profile.name)?.trim()
  if (!next || next === profile.name) return
  void run(() =>
    core('computerUse.manageProfile', {
      action: 'rename',
      profileId: profile.profileId,
      name: next,
    }),
  )
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

function allow(): void {
  void run(async () => {
    await core('computerUse.setSitePermission', {
      profileId: profileId.value,
      origin: origin.value.trim(),
      kind: kind.value,
      allow: true,
      ...(minutes.value ? { minutes: minutes.value } : {}),
    })
    origin.value = ''
  })
}

function revoke(permission: SitePermission): void {
  void run(() =>
    core('computerUse.setSitePermission', {
      profileId: permission.profileId,
      origin: permission.origin,
      kind: permission.kind,
      allow: false,
    }),
  )
}

onMounted(() => {
  void reload().catch((cause) => {
    error.value = String(cause)
  })
})
</script>

<template>
  <SettingsGroup
    title="浏览器 profile"
    description="持久 profile 保留该网站的 Cookie 与登录状态；清理时会关闭标签页并撤销关联授权。"
  >
    <p v-if="error" class="cu-settings-error" role="alert">{{ error }}</p>
    <SettingsRow
      v-for="profile in profiles"
      :key="profile.profileId"
      :title="profile.name"
      :description="`${profile.kind === 'temporary' ? '临时' : '持久'} · ${profile.openTargets} 个打开的标签页`"
      dense
    >
      <template v-if="profile.kind === 'persistent'">
        <Button
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="rename(profile)"
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
      </template>
    </SettingsRow>
    <form class="cu-settings-form" @submit.prevent="create">
      <label
        >新 profile 名称<input v-model="name" required maxlength="60"
      /></label>
      <Button type="submit" size="sm" :disabled="busy">新建 profile</Button>
    </form>
  </SettingsGroup>
  <SettingsGroup
    title="网站权限"
    description="摄像头、麦克风、位置、通知、剪贴板和全屏默认拒绝；只对指定 profile 与完整 origin 放行。"
  >
    <SettingsRow
      v-for="(permission, index) in permissions"
      :key="`${permission.profileId}:${permission.origin}:${permission.kind}:${index}`"
      :title="permission.origin"
      :description="`${permission.profileId} · ${kinds.find((item) => item.value === permission.kind)?.label ?? permission.kind}${permission.expiresAt ? ` · 到期 ${permission.expiresAt}` : ''}`"
      dense
    >
      <Button
        size="sm"
        variant="outline"
        :disabled="busy"
        @click="revoke(permission)"
        >撤销</Button
      >
    </SettingsRow>
    <p v-if="permissions.length === 0" class="cu-settings-note">
      尚未放行网站权限
    </p>
    <form class="cu-settings-form" @submit.prevent="allow">
      <label
        >profile<select v-model="profileId">
          <option
            v-for="profile in profiles"
            :key="profile.profileId"
            :value="profile.profileId"
          >
            {{ profile.name }}
          </option>
        </select></label
      >
      <label
        >完整 origin<input
          v-model="origin"
          required
          placeholder="https://example.com"
          spellcheck="false"
      /></label>
      <label
        >权限<select v-model="kind">
          <option v-for="item in kinds" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select></label
      >
      <label
        >有效分钟数（留空为持续）<input
          v-model.number="minutes"
          type="number"
          min="1"
          max="525600"
      /></label>
      <Button type="submit" size="sm" :disabled="busy">放行此站点权限</Button>
    </form>
  </SettingsGroup>
</template>

<style scoped>
.cu-settings-error {
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
}
.cu-settings-note {
  font-size: var(--fs-xs);
  color: rgb(var(--label-tertiary));
}
.cu-settings-form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-2);
  padding-top: var(--space-3);
}
.cu-settings-form label {
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}
.cu-settings-form input,
.cu-settings-form select {
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
}
</style>
