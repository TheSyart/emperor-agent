<script setup lang="ts">
/**
 * 设置 › 浏览器 › 密码管理器 — the credential vault Emperor fills from:
 * 保护 (how the vault is protected: Emperor's local key, and the master
 * password), 已保存 (one row per entry: 查看密码 / 编辑 / 删除) and 备份
 * (导出 / 导入 a password-protected `.emperor-vault`). 添加 (header) and
 * 编辑 open the entry form in a dialog; setting (typed twice), changing
 * (needs the current one) or entering the master password happens in a
 * small dialog too, and 移除主密码 is its own danger dialog, so the page
 * itself has no input fields. When the vault cannot be used a notice on top
 * says why and offers the way out: 从备份恢复 / 重新开始（先备份） for an
 * unreadable or newer vault.json, 修复权限 for a key other users can read,
 * 清空 (after a confirmation) for a lost or invalid key. Credential values
 * travel only over the trusted preload → main IPC.
 */
import { confirm } from '../../ui/confirm'
import { Plus } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  vaultExport,
  vaultImport,
  vaultImportPick,
  vaultLock,
  vaultMaster,
  vaultRemove,
  vaultRepairKey,
  vaultReset,
  vaultReveal,
  vaultSave,
  vaultStartOver,
  vaultStatus,
  vaultUnlock,
  type VaultEntry,
  type VaultStatus,
} from '../../../api/backend'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { useSettingsHeader } from '../settingsHeader'
import {
  EmptyState,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Checkbox,
  Notice,
  Badge,
  TextArea,
  TextField,
} from '../ui'
import {
  TOTP_WARNING,
  emptyForm,
  entryDescription,
  formFromEntry,
  parseBindings,
  totpPatch,
  unsignedAppWarning,
  unsignedFormWarning,
  usernamePatch,
  vaultAvailability,
  vaultEncryption,
  vaultErrorText,
  vaultProblem,
} from './credentialVaultModel'

const status = ref<VaultStatus | null>(null)
const busy = ref(false)
const error = ref('')
/** The entry form dialog; `editing` names the entry, null adds one. */
const formOpen = ref(false)
const editing = ref<string | null>(null)
const form = ref(emptyForm())
const password = ref('')
const totpSeed = ref('')
const master = ref('')
/** 更改: the current master password; set / change: the new one twice. */
const currentMaster = ref('')
const confirmMaster = ref('')
/** The master password dialog, when open. */
type ProtectDialog = 'unlock' | 'set' | 'change'
const protect = ref<ProtectDialog | null>(null)
/** 移除主密码: its own danger dialog, with the current master password. */
const removeOpen = ref(false)
/** 重新开始（先备份）: confirm in a dialog before the file is moved aside. */
const startOverOpen = ref(false)
/** 导出凭据备份: the passphrase, typed twice. */
const exportOpen = ref(false)
const passphrase = ref('')
const confirmPassphrase = ref('')
/** 导入 / 从备份恢复: the picked file's name while its passphrase is asked. */
const importName = ref<string | null>(null)
/** A one-time note after a backup, restore or new start. */
const note = ref('')
const PROTECT_TITLES: Record<ProtectDialog, string> = {
  unlock: '解锁密码管理器',
  set: '设置主密码',
  change: '更改主密码',
}
const PROTECT_SUBMIT: Record<ProtectDialog, string> = {
  unlock: '解锁',
  set: '保存',
  change: '保存',
}
const revealed = ref<{ handleId: string; password: string } | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null

const availability = computed(() => vaultAvailability(status.value))
const encryption = computed(() => vaultEncryption(status.value))
const problem = computed(() => vaultProblem(status.value))
const formUnsigned = computed(() => unsignedFormWarning(form.value.appBindings))
/** A dialog shows its own errors while it is open. */
const dialogOpen = computed(
  () =>
    formOpen.value ||
    protect.value !== null ||
    removeOpen.value ||
    startOverOpen.value ||
    exportOpen.value ||
    importName.value !== null,
)
const pageError = computed(() => (dialogOpen.value ? '' : error.value))
const importTitle = computed(() =>
  status.value?.problem ? '从备份恢复' : '导入凭据备份',
)
const masterDescription = computed(() =>
  status.value?.locked
    ? '已锁定，解锁后才能查看、编辑和代填。'
    : status.value?.hasMasterPassword
      ? '启动后或空闲 30 分钟后需重新解锁。'
      : '可选。设置后，启动后或空闲 30 分钟后需要用它解锁。',
)
const writable = computed(() =>
  Boolean(status.value?.available && !status.value.locked),
)

useSettingsHeader({
  actions: () =>
    writable.value
      ? [
          {
            id: 'add-credential',
            label: '添加',
            kind: 'primary',
            icon: Plus,
            onClick: add,
          },
        ]
      : [],
})

function hidePassword(): void {
  revealed.value = null
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

async function refresh(): Promise<void> {
  status.value = await vaultStatus()
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  note.value = ''
  try {
    await action()
    await refresh()
  } catch (cause) {
    error.value = vaultErrorText(cause)
    // The vault may have relocked on idle; show that instead of stale state.
    await refresh().catch(() => undefined)
  } finally {
    busy.value = false
  }
}

function resetForm(): void {
  formOpen.value = false
  editing.value = null
  form.value = emptyForm()
  password.value = ''
  totpSeed.value = ''
}

function add(): void {
  hidePassword()
  resetForm()
  formOpen.value = true
}

function edit(entry: VaultEntry): void {
  hidePassword()
  editing.value = entry.handleId
  form.value = formFromEntry(entry)
  password.value = ''
  totpSeed.value = ''
  formOpen.value = true
}

function onFormOpen(open: boolean): void {
  if (!open) resetForm()
}

function save(): void {
  void run(async () => {
    const bindings = parseBindings(form.value.origin, form.value.appBindings)
    await vaultSave({
      ...(editing.value ? { handleId: editing.value } : {}),
      label: form.value.label,
      bindings,
      ...usernamePatch(form.value, editing.value !== null),
      ...(password.value || !editing.value ? { password: password.value } : {}),
      ...totpPatch(form.value, totpSeed.value),
      revealUsername: form.value.revealUsername,
      fillMode: 'confirm',
    })
    resetForm()
  })
}

async function remove(handleId: string): Promise<void> {
  if (
    !(await confirm({
      title: '删除这个凭据？',
      body: '删除后无法恢复。',
      confirmLabel: '删除',
      tone: 'danger',
    }))
  )
    return
  void run(async () => {
    await vaultRemove(handleId)
    if (editing.value === handleId) resetForm()
  })
}

function reveal(handleId: string): void {
  hidePassword()
  void run(async () => {
    const value = await vaultReveal(handleId)
    revealed.value = { handleId, password: value }
    hideTimer = setTimeout(hidePassword, 30_000)
  })
}

function clearMasterFields(): void {
  master.value = ''
  currentMaster.value = ''
  confirmMaster.value = ''
}

function openProtect(kind: ProtectDialog): void {
  error.value = ''
  clearMasterFields()
  protect.value = kind
}

function onProtectOpen(open: boolean): void {
  if (!open) {
    protect.value = null
    clearMasterFields()
  }
}

function submitProtect(): void {
  if (protect.value === 'unlock') unlock()
  else setMaster()
}

function unlock(): void {
  void run(async () => {
    if (!(await vaultUnlock(master.value))) throw new Error('主密码不正确')
    master.value = ''
    protect.value = null
  })
}

/** 设置 / 更改: the new master password must be typed the same twice. */
function setMaster(): void {
  if (master.value !== confirmMaster.value) {
    error.value = '两次输入的主密码不一致。'
    return
  }
  const change = protect.value === 'change'
  void run(async () => {
    await vaultMaster(
      change
        ? {
            action: 'change',
            currentPassword: currentMaster.value,
            password: master.value,
            confirmPassword: confirmMaster.value,
          }
        : {
            action: 'set',
            password: master.value,
            confirmPassword: confirmMaster.value,
          },
    )
    clearMasterFields()
    protect.value = null
  })
}

function openRemove(): void {
  error.value = ''
  clearMasterFields()
  removeOpen.value = true
}

function onRemoveOpen(open: boolean): void {
  removeOpen.value = open
  if (!open) clearMasterFields()
}

/** 移除主密码: only with the current one; entries stay, sealed by the key. */
function removeMaster(): void {
  if (!currentMaster.value) {
    error.value = '请输入当前主密码。'
    return
  }
  void run(async () => {
    await vaultMaster({
      action: 'remove',
      currentPassword: currentMaster.value,
    })
    clearMasterFields()
    removeOpen.value = false
  })
}

/** 修复权限: the local key becomes readable by you only. */
function repairKey(): void {
  void run(async () => {
    if (!(await vaultRepairKey()))
      throw new Error(
        '无法修复权限：本地密钥文件的属主或类型不对。可以清空后重新开始。',
      )
  })
}

function openStartOver(): void {
  error.value = ''
  startOverOpen.value = true
}

/** 重新开始（先备份）: main moves vault.json aside, then starts empty. */
function startOver(): void {
  hidePassword()
  void run(async () => {
    const { backup } = await vaultStartOver()
    startOverOpen.value = false
    note.value = backup
      ? `原凭据库已另存为 ${backup}，现在从空的凭据库开始。`
      : '现在从空的凭据库开始。'
  })
}

function openExport(): void {
  error.value = ''
  passphrase.value = ''
  confirmPassphrase.value = ''
  exportOpen.value = true
}

function onExportOpen(open: boolean): void {
  exportOpen.value = open
  if (!open) {
    passphrase.value = ''
    confirmPassphrase.value = ''
  }
}

/** 导出凭据备份: main asks where to save it once the passphrases match. */
function exportBackup(): void {
  if (passphrase.value !== confirmPassphrase.value) {
    error.value = '两次输入的口令不一致。'
    return
  }
  void run(async () => {
    const result = await vaultExport(passphrase.value, confirmPassphrase.value)
    passphrase.value = ''
    confirmPassphrase.value = ''
    exportOpen.value = false
    if ('ok' in result) note.value = `凭据备份已导出到 ${result.name}。`
  })
}

/** 导入 / 从备份恢复: main's open dialog picks the file, then its passphrase. */
function startImport(): void {
  void run(async () => {
    const picked = await vaultImportPick()
    if ('canceled' in picked) return
    passphrase.value = ''
    importName.value = picked.name
  })
}

function onImportOpen(open: boolean): void {
  if (!open) {
    importName.value = null
    passphrase.value = ''
  }
}

function importBackup(): void {
  void run(async () => {
    const { imported } = await vaultImport(passphrase.value)
    passphrase.value = ''
    importName.value = null
    note.value = `已导入 ${imported} 个凭据。`
  })
}

/** 清空: the way out when the local key is lost or fails its checks. */
async function reset(): Promise<void> {
  if (
    !(await confirm({
      title: '清空密码库？',
      body: '已保存的密码和主密码都会删除，无法恢复。',
      confirmLabel: '清空',
      tone: 'danger',
    }))
  )
    return
  hidePassword()
  void run(vaultReset)
}

function removeTotpChanged(): void {
  if (form.value.removeTotp) totpSeed.value = ''
}

onMounted(() => {
  void refresh().catch((cause) => {
    error.value = vaultErrorText(cause)
  })
})
onBeforeUnmount(hidePassword)
</script>

<template>
  <SettingsSection
    intro="Emperor 操作网页和 App 时用来代填的账号密码，每次代填前都会请你确认。"
  >
    <Notice
      v-if="problem"
      tone="error"
      :title="problem.title"
      :description="problem.description"
    >
      <template #actions>
        <Button
          v-if="problem.actions.includes('repair')"
          size="sm"
          variant="primary"
          :disabled="busy"
          data-action="vault-repair-key"
          @click="repairKey"
          >修复权限</Button
        >
        <Button
          v-if="problem.actions.includes('restore')"
          size="sm"
          variant="secondary"
          :disabled="busy"
          data-action="vault-restore"
          @click="startImport"
          >从备份恢复</Button
        >
        <Button
          v-if="problem.actions.includes('start-over')"
          size="sm"
          variant="secondary"
          :disabled="busy"
          data-action="vault-start-over"
          @click="openStartOver"
          >重新开始（先备份）</Button
        >
        <Button
          v-if="problem.actions.includes('reset')"
          size="sm"
          variant="danger"
          :disabled="busy"
          data-action="vault-reset"
          @click="reset"
          >清空</Button
        >
      </template>
    </Notice>
    <Notice v-if="pageError" tone="error" :title="pageError" />
    <Notice v-if="note" tone="info" :title="note" />
    <SettingsGroup title="保护">
      <SettingsRow title="保护状态" :description="availability.description">
        <Badge :tone="availability.tone">{{ availability.badge }}</Badge>
      </SettingsRow>
      <SettingsRow
        v-if="encryption"
        title="加密方式"
        :description="encryption.description"
      >
        <Badge :tone="encryption.tone">{{ encryption.badge }}</Badge>
      </SettingsRow>
      <SettingsRow
        v-if="status?.available"
        title="主密码"
        :description="masterDescription"
      >
        <div class="vault-inline">
          <template v-if="status.locked">
            <Button
              size="sm"
              variant="secondary"
              :disabled="busy"
              data-action="vault-unlock"
              @click="openProtect('unlock')"
              >解锁</Button
            >
          </template>
          <template v-else-if="status.hasMasterPassword">
            <Button
              size="sm"
              variant="secondary"
              :disabled="busy"
              @click="run(vaultLock)"
              >锁定</Button
            >
            <Button
              size="sm"
              variant="secondary"
              :disabled="busy"
              data-action="vault-change-master"
              @click="openProtect('change')"
              >更改</Button
            >
            <Button
              size="sm"
              variant="danger"
              :disabled="busy"
              data-action="vault-remove-master"
              @click="openRemove"
              >移除主密码</Button
            >
          </template>
          <Button
            v-else
            size="sm"
            variant="secondary"
            :disabled="busy"
            data-action="vault-set-master"
            @click="openProtect('set')"
            >设置</Button
          >
        </div>
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup
      v-if="status?.available || status?.handles.length"
      title="已保存"
    >
      <EmptyState
        v-if="!status?.handles.length"
        title="还没有保存的密码"
        description="点右上角的「添加」保存一个。"
        variant="inline"
        framed
      />
      <SettingsRow
        v-for="handle in status?.handles ?? []"
        :key="handle.handleId"
        :title="handle.label"
        dense
      >
        <template #description>
          {{ entryDescription(handle) }}
          <span
            v-if="unsignedAppWarning(handle)"
            class="vault-warning vault-block"
            >{{ unsignedAppWarning(handle) }}</span
          >
        </template>
        <TextField
          v-if="revealed?.handleId === handle.handleId"
          class="vault-revealed"
          size="sm"
          monospace
          :model-value="revealed.password"
          readonly
          aria-label="已验证的密码，30 秒后隐藏"
        />
        <Button
          v-if="handle.fields.includes('password')"
          size="sm"
          variant="secondary"
          :disabled="busy || !writable"
          @click="reveal(handle.handleId)"
          >查看密码</Button
        >
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy || !writable"
          @click="edit(handle)"
          >编辑</Button
        >
        <Button
          size="sm"
          variant="danger"
          :disabled="busy || !writable"
          @click="remove(handle.handleId)"
          >删除</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup v-if="status?.available" title="备份">
      <SettingsRow
        title="导出凭据备份"
        description="把全部凭据和本地密钥加密成一个 .emperor-vault 文件，用你设的口令保护，可在另一台 Mac 或重装后导入。"
      >
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy || !writable"
          data-action="vault-export"
          @click="openExport"
          >导出…</Button
        >
      </SettingsRow>
      <SettingsRow
        title="导入凭据备份"
        description="把备份里的凭据合并进来，同一条凭据以备份为准；导入前会另存当前的凭据库。"
      >
        <Button
          size="sm"
          variant="secondary"
          :disabled="busy || !writable"
          data-action="vault-import"
          @click="startImport"
          >导入…</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <Modal
      :open="protect !== null"
      :title="protect ? PROTECT_TITLES[protect] : ''"
      :width="400"
      @update:open="onProtectOpen"
    >
      <form
        id="vault-protect-form"
        class="vault-protect"
        autocomplete="off"
        @submit.prevent="submitProtect"
      >
        <Notice v-if="error" tone="error" :title="error" />
        <label v-if="protect === 'unlock'"
          >主密码<TextField
            v-model="master"
            type="password"
            autocomplete="off"
            aria-label="主密码"
            required
        /></label>
        <template v-else>
          <label v-if="protect === 'change'"
            >当前主密码<TextField
              v-model="currentMaster"
              type="password"
              autocomplete="current-password"
              aria-label="当前主密码"
              required
          /></label>
          <label
            >新的主密码<TextField
              v-model="master"
              type="password"
              autocomplete="new-password"
              aria-label="新的主密码"
              required
          /></label>
          <label
            >再次输入新的主密码<TextField
              v-model="confirmMaster"
              type="password"
              autocomplete="new-password"
              aria-label="再次输入新的主密码"
              required
          /></label>
          <p class="vault-note">
            至少 12 个字符。忘记主密码就无法找回已保存的密码。
          </p>
        </template>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="protect = null"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="vault-protect-form"
          :disabled="busy"
          >{{ protect ? PROTECT_SUBMIT[protect] : '' }}</Button
        >
      </template>
    </Modal>
    <Modal
      :open="removeOpen"
      title="移除主密码"
      :width="400"
      @update:open="onRemoveOpen"
    >
      <form
        id="vault-remove-form"
        class="vault-dialog"
        autocomplete="off"
        @submit.prevent="removeMaster"
      >
        <Notice v-if="error" tone="error" :title="error" />
        <p class="vault-note">
          移除后，已保存的密码只由本地密钥保护：以你身份运行的程序也能读到这把密钥。
        </p>
        <label
          >当前主密码<TextField
            v-model="currentMaster"
            type="password"
            autocomplete="current-password"
            aria-label="当前主密码"
            required
        /></label>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="onRemoveOpen(false)"
          >取消</Button
        >
        <Button
          variant="danger"
          type="submit"
          form="vault-remove-form"
          :disabled="busy"
          >移除主密码</Button
        >
      </template>
    </Modal>
    <Modal
      :open="startOverOpen"
      title="重新开始（先备份）"
      :width="420"
      @update:open="startOverOpen = $event"
    >
      <div class="vault-dialog">
        <Notice v-if="error" tone="error" :title="error" />
        <p class="vault-note">
          现在的凭据库文件会原样另存为 vault.json.unreadable-时间 或
          vault.json.newer-时间（只有你能读），然后从一个空的凭据库开始。以后可以用更新的
          Emperor 或凭据备份找回原来的凭据。
        </p>
      </div>
      <template #footer>
        <Button variant="secondary" type="button" @click="startOverOpen = false"
          >取消</Button
        >
        <Button
          variant="danger"
          type="button"
          :disabled="busy"
          data-action="vault-start-over-confirm"
          @click="startOver"
          >备份并重新开始</Button
        >
      </template>
    </Modal>
    <Modal
      :open="exportOpen"
      title="导出凭据备份"
      :width="420"
      @update:open="onExportOpen"
    >
      <form
        id="vault-export-form"
        class="vault-dialog"
        autocomplete="off"
        @submit.prevent="exportBackup"
      >
        <Notice v-if="error" tone="error" :title="error" />
        <p class="vault-note">
          备份文件包含全部凭据和本地密钥，用这个口令加密（scrypt
          派生密钥）。至少 12 个字符；忘记口令就无法从备份恢复。
        </p>
        <label
          >备份口令<TextField
            v-model="passphrase"
            type="password"
            autocomplete="new-password"
            aria-label="备份口令"
            required
        /></label>
        <label
          >再次输入备份口令<TextField
            v-model="confirmPassphrase"
            type="password"
            autocomplete="new-password"
            aria-label="再次输入备份口令"
            required
        /></label>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="onExportOpen(false)"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="vault-export-form"
          :disabled="busy"
          >导出…</Button
        >
      </template>
    </Modal>
    <Modal
      :open="importName !== null"
      :title="importTitle"
      :width="420"
      @update:open="onImportOpen"
    >
      <form
        id="vault-import-form"
        class="vault-dialog"
        autocomplete="off"
        @submit.prevent="importBackup"
      >
        <Notice v-if="error" tone="error" :title="error" />
        <p class="vault-note">
          {{ importName }}：备份里的凭据会合并进来，同一条凭据以备份为准。
        </p>
        <label
          >备份口令<TextField
            v-model="passphrase"
            type="password"
            autocomplete="off"
            aria-label="备份口令"
            required
        /></label>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="onImportOpen(false)"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="vault-import-form"
          :disabled="busy"
          >导入</Button
        >
      </template>
    </Modal>
    <Modal
      :open="formOpen"
      :title="editing ? '编辑凭据' : '添加凭据'"
      :width="480"
      @update:open="onFormOpen"
    >
      <form
        id="credential-form"
        class="vault-form"
        autocomplete="off"
        @submit.prevent="save"
      >
        <Notice v-if="error" tone="error" :title="error" />
        <label
          >名称<TextField v-model="form.label" required maxlength="120"
        /></label>
        <label
          >网站 origin（每行一个）<TextArea
            :min-rows="2"
            v-model="form.origin"
            placeholder="https://example.com"
            spellcheck="false"
          />
        </label>
        <label
          >macOS App 绑定（每行 Bundle ID | Team ID | 绝对路径）<TextArea
            :min-rows="2"
            v-model="form.appBindings"
            placeholder="com.example.Writer | EXAMPLE123 |&#10;com.example.Unsigned | | /Applications/Unsigned.app"
            spellcheck="false"
          />
        </label>
        <p class="vault-note">
          App 绑定须填写 Team ID；未签名 App
          可填写精确应用路径。若两者都填写，代填时两者都必须匹配。
        </p>
        <p v-if="formUnsigned" class="vault-warning">{{ formUnsigned }}</p>
        <label
          >用户名<TextField
            v-model="form.username"
            autocomplete="off"
            :placeholder="
              form.usernameHidden ? '已保存但不显示，留空则保持不变' : ''
            "
        /></label>
        <label
          >密码<TextField
            v-model="password"
            type="password"
            autocomplete="new-password"
            :required="!editing"
            :placeholder="editing ? '留空则保持不变' : ''"
        /></label>
        <label
          >TOTP 密钥（可选）<TextField
            v-model="totpSeed"
            type="password"
            autocomplete="off"
            :disabled="form.removeTotp"
            :placeholder="form.totpSaved ? '已保存，留空则保持不变' : ''"
        /></label>
        <Checkbox
          v-if="editing && form.totpSaved"
          v-model="form.removeTotp"
          class="vault-check"
          @change="removeTotpChanged"
          >删除已保存的 TOTP 密钥</Checkbox
        >
        <p v-if="totpSeed" class="vault-warning">{{ TOTP_WARNING }}</p>
        <Checkbox v-model="form.revealUsername" class="vault-check"
          >允许 Agent 查看用户名</Checkbox
        >
        <p class="vault-note">
          Agent 每次代填账号、密码或验证码前都会暂停并请你确认。
        </p>
      </form>
      <template #footer>
        <Button variant="secondary" type="button" @click="resetForm"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          form="credential-form"
          :disabled="busy"
          >{{ editing ? '保存修改' : '添加' }}</Button
        >
      </template>
    </Modal>
  </SettingsSection>
</template>

<style scoped>
.vault-inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.vault-form,
.vault-protect,
.vault-dialog {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-3);
}
.vault-form label:not(.vault-check),
.vault-protect label:not(.vault-check),
.vault-dialog label:not(.vault-check) {
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}
.vault-revealed {
  width: auto;
  min-width: 0;
}
.vault-inline .vault-check {
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
  white-space: nowrap;
}
.vault-warning {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--state-warn-label));
}
.vault-block {
  display: block;
}
.vault-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--label-tertiary));
}
</style>
