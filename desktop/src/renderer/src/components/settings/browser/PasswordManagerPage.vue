<script setup lang="ts">
/**
 * 设置 › 浏览器 › 密码管理器 — the credential vault Emperor fills from:
 * 保护 (how the vault is protected: Emperor's local key, and the master
 * password) and 已保存 (one row per entry: 查看密码 / 编辑 / 删除). 添加
 * (header) and 编辑 open the entry form in a dialog; setting, changing or
 * entering the master password happens in a small dialog too, so the page
 * itself has no input fields. When the local key is lost or fails its
 * checks, a notice on top offers 清空 (after a confirmation). Credential
 * values travel only over the trusted preload → main IPC.
 */
import { Plus } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  vaultLock,
  vaultRemove,
  vaultReset,
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
  SettingsNotice,
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
/** The master password dialog, when open. */
type ProtectDialog = 'unlock' | 'set' | 'change'
const protect = ref<ProtectDialog | null>(null)
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
  protect.value = kind
}

function onProtectOpen(open: boolean): void {
  if (!open) protect.value = null
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

function setMaster(): void {
  void run(async () => {
    await vaultSetMaster(master.value || null)
    master.value = ''
    protect.value = null
  })
}

/** 清空: the way out when the local key is lost or fails its checks. */
function reset(): void {
  if (
    !window.confirm(
      '清空后，已保存的密码和主密码都会删除，无法恢复。确定清空？',
    )
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
    <SettingsNotice
      v-if="problem"
      tone="error"
      :title="problem.title"
      :description="problem.description"
    >
      <template #actions>
        <Button
          size="sm"
          variant="danger"
          :disabled="busy"
          data-action="vault-reset"
          @click="reset"
          >清空</Button
        >
      </template>
    </SettingsNotice>
    <SettingsNotice v-if="pageError" tone="error" :title="pageError" />
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
          :disabled="busy || !writable"
          @click="reveal(handle.handleId)"
          >查看密码</Button
        >
        <Button
          size="sm"
          variant="outline"
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
        <SettingsNotice v-if="error" tone="error" :title="error" />
        <label v-if="protect === 'unlock'"
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
              ? '至少 12 个字符；留空保存会关闭主密码。'
              : '至少 12 个字符。忘记主密码就无法找回已保存的密码。'
          }}
        </p>
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
        <SettingsNotice v-if="error" tone="error" :title="error" />
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
