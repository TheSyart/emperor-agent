<script setup lang="ts">
/**
 * 设置 › 浏览器 › 网站设置 — site permissions for the pages Emperor
 * operates in the built-in browser. Camera, microphone, location,
 * notifications, clipboard and fullscreen are denied unless allowed here
 * for one profile and one exact origin, optionally for a limited time.
 * 放行 (header) opens the dialog; each row can be revoked.
 */
import type {
  BrowserProfileView,
  SitePermission,
  SitePermissionKind,
} from '@emperor/core/runtime-contract'
import { Plus } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { core } from '../../../api/http'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { useSettingsHeader } from '../settingsHeader'
import {
  EmptyState,
  Field,
  Select,
  SettingsGroup,
  Notice,
  SettingsRow,
  SettingsSection,
  TextField,
  type SelectOption,
} from '../ui'

const KINDS: readonly SelectOption<SitePermissionKind>[] = [
  { value: 'camera', label: '摄像头' },
  { value: 'microphone', label: '麦克风' },
  { value: 'geolocation', label: '位置' },
  { value: 'notifications', label: '通知' },
  { value: 'clipboard-read', label: '读取剪贴板' },
  { value: 'clipboard-write', label: '写入剪贴板' },
  { value: 'fullscreen', label: '全屏' },
]

const profiles = ref<BrowserProfileView[]>([])
const permissions = ref<SitePermission[]>([])
const busy = ref(false)
const error = ref('')
const dialogOpen = ref(false)
const profileId = ref('temporary')
const origin = ref('')
const kind = ref<SitePermissionKind>('notifications')
const minutes = ref('')

const profileOptions = computed<SelectOption[]>(() =>
  profiles.value.map((profile) => ({
    value: profile.profileId,
    label: profile.name,
  })),
)

function kindLabel(value: SitePermissionKind): string {
  return KINDS.find((item) => item.value === value)?.label ?? value
}

function profileName(id: string): string {
  return profiles.value.find((profile) => profile.profileId === id)?.name ?? id
}

function describe(permission: SitePermission): string {
  const parts = [kindLabel(permission.kind), profileName(permission.profileId)]
  if (permission.expiresAt) parts.push(`到期 ${permission.expiresAt}`)
  return parts.join(' · ')
}

async function reload(): Promise<void> {
  ;[profiles.value, permissions.value] = await Promise.all([
    core('computerUse.listProfiles'),
    core('computerUse.listSitePermissions'),
  ])
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

function openDialog(): void {
  error.value = ''
  origin.value = ''
  minutes.value = ''
  kind.value = 'notifications'
  if (!profiles.value.some((profile) => profile.profileId === profileId.value))
    profileId.value = profiles.value[0]?.profileId ?? 'temporary'
  dialogOpen.value = true
}

async function allow(): Promise<void> {
  const limit = Number.parseInt(minutes.value, 10)
  const saved = await run(() =>
    core('computerUse.setSitePermission', {
      profileId: profileId.value,
      origin: origin.value.trim(),
      kind: kind.value,
      allow: true,
      ...(limit > 0 ? { minutes: limit } : {}),
    }),
  )
  if (saved) dialogOpen.value = false
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

useSettingsHeader({
  actions: () => [
    {
      id: 'allow-site',
      label: '放行',
      kind: 'primary',
      icon: Plus,
      onClick: openDialog,
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
    intro="Emperor 操作的网页请求摄像头、麦克风等权限时默认一律拒绝，这里放行的除外。"
  >
    <Notice v-if="error && !dialogOpen" tone="error" :title="error" />
    <SettingsGroup title="已放行">
      <EmptyState
        v-if="!permissions.length"
        title="暂无"
        description="点右上角的「放行」为一个网站开放权限。"
        variant="inline"
        framed
      />
      <SettingsRow
        v-for="(permission, index) in permissions"
        :key="`${permission.profileId}:${permission.origin}:${permission.kind}:${index}`"
        :title="permission.origin"
        :description="describe(permission)"
        dense
      >
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="revoke(permission)"
          >撤销</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <Modal v-model:open="dialogOpen" title="放行网站权限" :width="440">
      <form id="site-form" class="site-form" @submit.prevent="allow">
        <Notice v-if="error" tone="error" :title="error" />
        <Field label="网址" hint="完整的 origin，例如 https://meet.example.com">
          <TextField
            v-model="origin"
            required
            monospace
            placeholder="https://example.com"
            spellcheck="false"
          />
        </Field>
        <Field label="权限">
          <Select v-model="kind" :options="KINDS" block />
        </Field>
        <Field label="登录档案">
          <Select v-model="profileId" :options="profileOptions" block />
        </Field>
        <Field label="有效分钟数" hint="留空表示一直有效">
          <TextField v-model="minutes" type="number" min="1" max="525600" />
        </Field>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="dialogOpen = false"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="site-form"
          :disabled="busy || !origin.trim()"
          >放行</Button
        >
      </template>
    </Modal>
  </SettingsSection>
</template>

<style scoped>
.site-form {
  display: grid;
  gap: var(--space-3);
}
</style>
