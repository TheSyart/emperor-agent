<script setup lang="ts">
/** Credential values travel only over the trusted preload → main IPC. */
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
import { SettingsGroup, SettingsRow, StatusBadge } from '../ui'
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
const revealed = ref<{ handleId: string; password: string } | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null

const availability = computed(() => vaultAvailability(status.value))
const encryption = computed(() => vaultEncryption(status.value))
const biometricOffered = computed(() =>
  Boolean(status.value?.hasMasterPassword && status.value.biometricSupported),
)
const formUnsigned = computed(() => unsignedFormWarning(form.value.appBindings))

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
  editing.value = null
  form.value = emptyForm()
  password.value = ''
  totpSeed.value = ''
}

function edit(entry: VaultEntry): void {
  hidePassword()
  editing.value = entry.handleId
  form.value = formFromEntry(entry)
  password.value = ''
  totpSeed.value = ''
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

function unlock(): void {
  void run(async () => {
    const biometric = biometricOffered.value && unlockBiometric.value
    if (!(await vaultUnlock(master.value, { biometric })))
      throw new Error('主密码不正确')
    master.value = ''
    unlockBiometric.value = false
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
  <SettingsGroup
    title="凭据"
    description="保存网站或 macOS App 凭据。Agent 只得到名称和句柄；秘密在主进程解密，由受信驱动代填到精确绑定的目标。"
  >
    <p v-if="error" class="vault-error" role="alert">{{ error }}</p>
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
      <StatusBadge :tone="encryption.tone">{{ encryption.badge }}</StatusBadge>
    </SettingsRow>
    <SettingsRow
      v-if="status?.hasMasterPassword"
      title="主密码"
      description="启动后或空闲 30 分钟后需重新解锁。"
    >
      <div class="vault-inline">
        <template v-if="status.locked">
          <input
            v-model="master"
            type="password"
            autocomplete="off"
            aria-label="主密码"
          />
          <label
            v-if="biometricOffered && !status.biometricUnlock"
            class="vault-check"
            ><input v-model="unlockBiometric" type="checkbox" />允许 Touch ID
            解锁</label
          >
          <Button size="sm" :disabled="busy" @click="unlock">解锁</Button>
          <Button
            v-if="biometricOffered && status.biometricUnlock"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="unlockWithTouchId"
            >使用 Touch ID</Button
          >
        </template>
        <Button
          v-else
          size="sm"
          variant="outline"
          :disabled="busy"
          @click="run(vaultLock)"
          >锁定</Button
        >
      </div>
    </SettingsRow>
    <SettingsRow
      v-if="biometricOffered && (status?.biometricUnlock || !status?.locked)"
      title="Touch ID 解锁"
      :description="
        status?.biometricUnlock
          ? '可用 Touch ID 或 Mac 登录密码代替主密码解锁。能通过这项系统验证的人，都能解锁凭据库。'
          : '开启后可用 Touch ID 或 Mac 登录密码代替主密码解锁。开启前需再输入一次主密码。'
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
      <div v-else class="vault-inline">
        <input
          v-model="confirmMaster"
          type="password"
          autocomplete="off"
          aria-label="确认主密码"
        />
        <Button
          size="sm"
          variant="outline"
          :disabled="busy || !confirmMaster"
          @click="enableTouchId"
          >开启</Button
        >
      </div>
    </SettingsRow>
    <SettingsRow
      v-if="status?.available && !status.locked"
      :title="status.hasMasterPassword ? '更改或关闭主密码' : '设置主密码'"
      :description="
        status.biometricUnlock
          ? '留空保存将关闭主密码。至少 12 个字符。更改或关闭主密码会同时关闭 Touch ID 解锁，勾选后可为新密码重新开启。'
          : '留空保存将关闭主密码。至少 12 个字符。'
      "
    >
      <div class="vault-inline">
        <input
          v-model="master"
          type="password"
          autocomplete="new-password"
          aria-label="新的主密码"
        />
        <label v-if="status.biometricSupported && master" class="vault-check"
          ><input v-model="masterBiometric" type="checkbox" />允许 Touch ID
          解锁</label
        >
        <Button size="sm" variant="outline" :disabled="busy" @click="setMaster"
          >保存</Button
        >
      </div>
    </SettingsRow>
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
    <form
      v-if="status?.available && !status.locked"
      class="vault-form"
      autocomplete="off"
      @submit.prevent="save"
    >
      <h4>{{ editing ? '编辑凭据' : '新增凭据' }}</h4>
      <label>名称<input v-model="form.label" required maxlength="120" /></label>
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
      <div class="vault-inline">
        <Button type="submit" size="sm" :disabled="busy">{{
          editing ? '保存修改' : '添加凭据'
        }}</Button>
        <Button
          v-if="editing"
          size="sm"
          variant="outline"
          type="button"
          @click="resetForm"
          >取消</Button
        >
      </div>
    </form>
  </SettingsGroup>
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
.vault-form {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-3);
}
.vault-form h4 {
  margin: 0;
  font-size: var(--fs-s);
}
.vault-form label {
  display: grid;
  gap: var(--space-1);
  font-size: var(--fs-xs);
  color: rgb(var(--label-secondary));
}
.vault-form input:not([type='checkbox']),
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
.vault-inline .vault-check {
  display: flex;
  align-items: center;
  gap: var(--space-1);
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
