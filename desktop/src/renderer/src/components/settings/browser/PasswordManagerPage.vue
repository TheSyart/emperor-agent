<script setup lang="ts">
/**
 * 设置 › 浏览器 › 密码管理器 — the credential vault Emperor fills from:
 * 保护 (how the vault is protected; the master password and Touch ID) and
 * 已保存 (one row per entry: 查看密码 / 编辑 / 删除). 添加 (header) and 编辑
 * open the entry form in a dialog; setting, changing or entering the master
 * password and turning Touch ID on happen in a small dialog too, so the
 * page itself has no input fields. Credential values travel only over the
 * trusted preload → main IPC.
 */
import { Plus } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  vaultBiometricDisable,
  vaultBiometricUnlock,
  vaultLock,
  vaultRemove,
  vaultReveal,
  vaultSave,
  vaultSetMaster,
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
  StatusBadge,
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
/** Opt into Touch ID unlock with the password being unlocked or set. */
const unlockBiometric = ref(false)
const masterBiometric = ref(false)
/** Re-entered master password that turns Touch ID unlock on while unlocked. */
const confirmMaster = ref('')
/** The master password / Touch ID dialog, when open. */
type ProtectDialog = 'unlock' | 'set' | 'change' | 'touch-id'
const protect = ref<ProtectDialog | null>(null)
const PROTECT_TITLES: Record<ProtectDialog, string> = {
  unlock: '解锁密码管理器',
  set: '设置主密码',
  change: '更改主密码',
  'touch-id': '开启 Touch ID 解锁',
}
const PROTECT_SUBMIT: Record<ProtectDialog, string> = {
  unlock: '解锁',
  set: '保存',
  change: '保存',
  'touch-id': '开启',
}
const revealed = ref<{ handleId: string; password: string } | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null

const availability = computed(() => vaultAvailability(status.value))
const encryption = computed(() => vaultEncryption(status.value))
const biometricOffered = computed(() =>
  Boolean(status.value?.hasMasterPassword && status.value.biometricSupported),
)
const formUnsigned = computed(() => unsignedFormWarning(form.value.appBindings))
/** A dialog shows its own errors while it is open. */
const pageError = computed(() =>
  formOpen.value || protect.value ? '' : error.value,
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

function remove(handleId: string): void {
  if (!window.confirm('确定删除这个凭据？删除后无法恢复。')) return
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

function openProtect(kind: ProtectDialog): void {
  error.value = ''
  master.value = ''
  confirmMaster.value = ''
  unlockBiometric.value = false
  masterBiometric.value = false
  protect.value = kind
}

function onProtectOpen(open: boolean): void {
  if (!open) protect.value = null
}

function submitProtect(): void {
  if (protect.value === 'unlock') unlock()
  else if (protect.value === 'touch-id') enableTouchId()
  else setMaster()
}

function unlock(): void {
  void run(async () => {
    const biometric = biometricOffered.value && unlockBiometric.value
    if (!(await vaultUnlock(master.value, { biometric })))
      throw new Error('主密码不正确')
    master.value = ''
    unlockBiometric.value = false
    protect.value = null
  })
}

function unlockWithTouchId(): void {
  void run(async () => {
    await vaultBiometricUnlock()
  })
}

function enableTouchId(): void {
  void run(async () => {
    if (!(await vaultUnlock(confirmMaster.value, { biometric: true })))
      throw new Error('主密码不正确')
    confirmMaster.value = ''
    protect.value = null
  })
}

function setMaster(): void {
  void run(async () => {
    const biometric =
      Boolean(master.value) &&
      Boolean(status.value?.biometricSupported) &&
      masterBiometric.value
    await vaultSetMaster(master.value || null, { biometric })
    master.value = ''
    masterBiometric.value = false
    protect.value = null
  })
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
    intro="保存网站或 macOS App 的账号密码，供 Emperor 操作网页和应用时代填。Emperor 只拿到名称和句柄；密码在主进程解密，由受信驱动代填到精确绑定的目标，每次代填前都会请你确认。"
  >
    <p v-if="pageError" class="vault-error" role="alert">{{ error }}</p>
    <SettingsGroup title="保护">
      <SettingsRow title="保护状态" :description="availability.description">
        <StatusBadge :tone="availability.tone">{{
          availability.badge
        }}</StatusBadge>
      </SettingsRow>
      <SettingsRow
        v-if="encryption"
        title="加密方式"
        :description="encryption.description"
      >
        <StatusBadge :tone="encryption.tone">{{
          encryption.badge
        }}</StatusBadge>
      </SettingsRow>
      <SettingsRow
        v-if="status?.available"
        title="主密码"
        :description="masterDescription"
      >
        <div class="vault-inline">
          <template v-if="status.locked">
            <Button
              v-if="biometricOffered && status.biometricUnlock"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="unlockWithTouchId"
              >使用 Touch ID</Button
            >
            <Button
              size="sm"
              variant="outline"
              :disabled="busy"
              data-action="vault-unlock"
              @click="openProtect('unlock')"
              >解锁</Button
            >
          </template>
          <template v-else-if="status.hasMasterPassword">
            <Button
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="run(vaultLock)"
              >锁定</Button
            >
            <Button
              size="sm"
              variant="outline"
              :disabled="busy"
              data-action="vault-change-master"
              @click="openProtect('change')"
              >更改</Button
            >
          </template>
          <Button
            v-else
            size="sm"
            variant="outline"
            :disabled="busy"
            data-action="vault-set-master"
            @click="openProtect('set')"
            >设置</Button
          >
        </div>
      </SettingsRow>
      <SettingsRow
        v-if="biometricOffered && (status?.biometricUnlock || !status?.locked)"
        title="Touch ID 解锁"
        :description="
          status?.biometricUnlock
            ? '可用 Touch ID 或 Mac 登录密码代替主密码解锁。能通过这项系统验证的人，都能解锁凭据库。'
            : '开启后可用 Touch ID 或 Mac 登录密码代替主密码解锁。'
        "
      >
        <div v-if="status?.biometricUnlock" class="vault-inline">
          <StatusBadge tone="ok">已开启</StatusBadge>
          <Button
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="run(vaultBiometricDisable)"
            >关闭</Button
          >
        </div>
        <Button
          v-else
          size="sm"
          variant="outline"
          :disabled="busy"
          data-action="vault-touch-id"
          @click="openProtect('touch-id')"
          >开启</Button
        >
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup
      v-if="status?.available || status?.handles.length"
      title="已保存"
    >
      <EmptyState
        v-if="!status?.handles.length"
        compact
        title="还没有保存的密码"
        description="点右上角的「添加」保存一个。"
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
        <input
          v-if="revealed?.handleId === handle.handleId"
          :value="revealed.password"
          readonly
          aria-label="已验证的密码，30 秒后隐藏"
        />
        <Button
          v-if="handle.fields.includes('password')"
          size="sm"
          variant="outline"
          :disabled="busy || status?.locked"
          @click="reveal(handle.handleId)"
          >查看密码</Button
        >
        <Button
          size="sm"
          variant="outline"
          :disabled="busy || status?.locked"
          @click="edit(handle)"
          >编辑</Button
        >
        <Button
          size="sm"
          variant="danger"
          :disabled="busy || status?.locked"
          @click="remove(handle.handleId)"
          >删除</Button
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
        <p v-if="error" class="vault-error" role="alert">{{ error }}</p>
        <label v-if="protect === 'touch-id'"
          >主密码<input
            v-model="confirmMaster"
            type="password"
            autocomplete="off"
            aria-label="确认主密码"
            required
        /></label>
        <label v-else-if="protect === 'unlock'"
          >主密码<input
            v-model="master"
            type="password"
            autocomplete="off"
            aria-label="主密码"
            required
        /></label>
        <label v-else
          >新的主密码<input
            v-model="master"
            type="password"
            autocomplete="new-password"
            aria-label="新的主密码"
            :required="protect === 'set'"
        /></label>
        <p v-if="protect === 'set' || protect === 'change'" class="vault-note">
          {{
            protect === 'change'
              ? '至少 12 个字符；留空保存会关闭主密码。更改或关闭主密码会同时关闭 Touch ID 解锁。'
              : '至少 12 个字符。'
          }}
        </p>
        <p v-if="protect === 'touch-id'" class="vault-note">
          开启后，能通过 Touch ID 或 Mac 登录密码验证的人，都能解锁凭据库。
        </p>
        <label
          v-if="
            protect === 'unlock' && biometricOffered && !status?.biometricUnlock
          "
          class="vault-check"
          ><input v-model="unlockBiometric" type="checkbox" />允许 Touch ID
          解锁</label
        >
        <label
          v-if="
            (protect === 'set' || protect === 'change') &&
            status?.biometricSupported &&
            master
          "
          class="vault-check"
          ><input v-model="masterBiometric" type="checkbox" />允许 Touch ID
          解锁</label
        >
      </form>
      <template #footer>
        <Button variant="outline" type="button" @click="protect = null"
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
        <p v-if="error" class="vault-error" role="alert">{{ error }}</p>
        <label
          >名称<input v-model="form.label" required maxlength="120"
        /></label>
        <label
          >网站 origin（每行一个）<textarea
            v-model="form.origin"
            placeholder="https://example.com"
            spellcheck="false"
          />
        </label>
        <label
          >macOS App 绑定（每行 Bundle ID | Team ID | 绝对路径）<textarea
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
          >用户名<input
            v-model="form.username"
            autocomplete="off"
            :placeholder="
              form.usernameHidden ? '已保存但不显示，留空则保持不变' : ''
            "
        /></label>
        <label
          >密码<input
            v-model="password"
            type="password"
            autocomplete="new-password"
            :required="!editing"
            :placeholder="editing ? '留空则保持不变' : ''"
        /></label>
        <label
          >TOTP 密钥（可选）<input
            v-model="totpSeed"
            type="password"
            autocomplete="off"
            :disabled="form.removeTotp"
            :placeholder="form.totpSaved ? '已保存，留空则保持不变' : ''"
        /></label>
        <label v-if="editing && form.totpSaved" class="vault-check"
          ><input
            v-model="form.removeTotp"
            type="checkbox"
            @change="removeTotpChanged"
          />删除已保存的 TOTP 密钥</label
        >
        <p v-if="totpSeed" class="vault-warning">{{ TOTP_WARNING }}</p>
        <label class="vault-check"
          ><input v-model="form.revealUsername" type="checkbox" />允许 Agent
          查看用户名</label
        >
        <p class="vault-note">
          Agent 每次代填账号、密码或验证码前都会暂停并请你确认。
        </p>
      </form>
      <template #footer>
        <Button variant="outline" type="button" @click="resetForm">取消</Button>
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
.vault-error {
  color: rgb(var(--danger));
  font-size: var(--fs-xs);
}
.vault-inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.vault-form,
.vault-protect {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-3);
}
.vault-form label,
.vault-protect label {
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}
.vault-form input:not([type='checkbox']),
.vault-protect input:not([type='checkbox']),
.vault-form select,
.vault-form textarea,
.vault-inline input:not([type='checkbox']) {
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border-l2);
  border-radius: var(--radius-row);
  background: transparent;
  color: rgb(var(--label-primary));
}
.vault-form .vault-check,
.vault-protect .vault-check,
.vault-inline .vault-check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.vault-check input[type='checkbox'] {
  flex: none;
  width: auto;
  margin: 0;
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
