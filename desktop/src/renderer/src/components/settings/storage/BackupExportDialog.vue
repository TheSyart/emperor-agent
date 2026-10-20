<script setup lang="ts">
/**
 * BackupExportDialog — 导出备份 (REL-03). Opening it asks main what a
 * backup would hold (by category, with sizes) and whether the 密码管理器
 * can go in. 包含会话 is on by default; 包含密码管理器 needs saved entries
 * and an unlocked vault, and a passphrase typed twice (≥ 12 characters):
 * the vault and the local key go in only sealed under it (SEC-09). Main
 * then asks where to save the `.emperor-backup.zip`. After the export: the
 * file name and folder, 在访达中显示 and 完成.
 *
 * Props: open (v-model).
 */
import { computed, ref, watch } from 'vue'
import {
  exportHomeBackup,
  planHomeBackup,
  revealHomeBackup,
  type HomeBackupPlan,
} from '../../../api/homeBackup'
import Button from '../../ui/Button.vue'
import Checkbox from '../../ui/Checkbox.vue'
import Field from '../../ui/Field.vue'
import Modal from '../../ui/Modal.vue'
import Spinner from '../../ui/Spinner.vue'
import TextField from '../../ui/TextField.vue'
import { formatStorageBytes } from './storageModel'
import { backupErrorText, passphraseProblem } from './backupModel'

const open = defineModel<boolean>('open', { default: false })

const plan = ref<HomeBackupPlan | null>(null)
const loading = ref(false)
const exporting = ref(false)
const error = ref('')
const includeSessions = ref(true)
const includeCredentials = ref(false)
const passphrase = ref('')
const confirmation = ref('')
const done = ref<{
  name: string
  location: string
  credentials: boolean
} | null>(null)

const vault = computed(
  () => plan.value?.vault ?? { state: 'unavailable' as const, entries: 0 },
)
const sessions = computed(() =>
  plan.value?.categories.find((category) => category.id === 'sessions'),
)
const total = computed(() =>
  formatStorageBytes(
    (plan.value?.categories ?? [])
      .filter((category) => includeSessions.value || !category.optional)
      .reduce((sum, category) => sum + category.bytes, 0),
  ),
)
const vaultHint = computed(() => {
  switch (vault.value.state) {
    case 'ready':
      return `${vault.value.entries} 条凭据和本地密钥用备份口令加密后才放进备份；忘记口令就无法恢复它们。`
    case 'empty':
      return '密码管理器里还没有保存的凭据。'
    case 'locked':
      return '先在 设置 › 浏览器 › 密码管理器 解锁，才能把凭据放进备份。'
    default:
      return '密码管理器现在不可用，凭据不会放进备份。'
  }
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  plan.value = null
  done.value = null
  includeSessions.value = true
  includeCredentials.value = false
  passphrase.value = ''
  confirmation.value = ''
  try {
    plan.value = await planHomeBackup()
  } catch (cause) {
    error.value = backupErrorText(cause)
  } finally {
    loading.value = false
  }
}

async function exportBackup(): Promise<void> {
  if (!plan.value || exporting.value) return
  error.value = ''
  const withVault = includeCredentials.value && vault.value.state === 'ready'
  if (withVault) {
    const problem = passphraseProblem(passphrase.value, confirmation.value)
    if (problem) {
      error.value = problem
      return
    }
  }
  exporting.value = true
  try {
    const result = await exportHomeBackup({
      includeSessions: includeSessions.value,
      ...(withVault
        ? { passphrase: passphrase.value, confirmation: confirmation.value }
        : {}),
    })
    if (result.ok) {
      done.value = result
      passphrase.value = ''
      confirmation.value = ''
    }
  } catch (cause) {
    error.value = backupErrorText(cause)
  } finally {
    exporting.value = false
  }
}

async function reveal(): Promise<void> {
  error.value = ''
  try {
    await revealHomeBackup()
  } catch (cause) {
    error.value = backupErrorText(cause)
  }
}

function close(): void {
  passphrase.value = ''
  confirmation.value = ''
  open.value = false
}

watch(
  open,
  (value) => {
    if (value) void load()
  },
  { immediate: true },
)
</script>

<template>
  <Modal v-model:open="open" title="导出备份" :width="520">
    <div class="backup-dialog" data-testid="backup-export-dialog">
      <template v-if="done">
        <p class="result" role="status">
          <span
            >已导出 <strong>{{ done.name }}</strong></span
          >
          <span class="where">保存在 {{ done.location }}</span>
        </p>
        <p class="lead">
          {{
            done.credentials
              ? '密码管理器已用口令加密放进备份，恢复时需要同一个口令。'
              : '备份里没有密码管理器和本地密钥。'
          }}
          恢复时在「设置 › 高级 › 存储」选择这个文件。
        </p>
      </template>
      <template v-else>
        <p class="lead">
          备份是一个 .emperor-backup.zip 文件，只保存在你选择的位置，Emperor
          不会上传。
        </p>
        <div v-if="loading" class="loading">
          <Spinner size="sm" /> 正在统计要备份的内容…
        </div>
        <template v-else-if="plan">
          <ul class="categories" aria-label="备份内容">
            <li
              v-for="category in plan.categories"
              :key="category.id"
              class="category"
              :data-category="category.id"
              :data-off="category.optional && !includeSessions ? '' : undefined"
            >
              <span class="title">{{ category.title }}</span>
              <span class="description">{{ category.description }}</span>
              <span class="size">{{ formatStorageBytes(category.bytes) }}</span>
            </li>
          </ul>
          <div class="options">
            <div class="option" data-option="sessions">
              <Checkbox v-model="includeSessions" label="包含会话" />
              <p class="hint">
                会话记录、附件与用量记录（{{
                  formatStorageBytes(sessions?.bytes ?? 0)
                }}）。不包含时，恢复不会改动当时的会话。
              </p>
            </div>
            <div class="option" data-option="credentials">
              <Checkbox
                v-model="includeCredentials"
                label="包含密码管理器"
                :disabled="vault.state !== 'ready'"
              />
              <p class="hint">{{ vaultHint }}</p>
            </div>
            <div
              v-if="includeCredentials && vault.state === 'ready'"
              class="passphrase"
            >
              <Field label="备份口令" hint="至少 12 个字符">
                <TextField
                  v-model="passphrase"
                  type="password"
                  autocomplete="new-password"
                />
              </Field>
              <Field label="再输入一次">
                <TextField
                  v-model="confirmation"
                  type="password"
                  autocomplete="new-password"
                />
              </Field>
            </div>
          </div>
          <p class="summary">
            约 {{ total }}（压缩前）。模型 Key 在备份里仍用本机密钥加密。
          </p>
          <p class="excluded" data-testid="backup-excluded">
            <span class="excluded-label">不包含</span>
            {{ plan.excluded.join('、') }}
          </p>
        </template>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <template v-if="done">
          <Button variant="secondary" data-action="reveal" @click="reveal"
            >在访达中显示</Button
          >
          <Button variant="primary" data-action="done" @click="close"
            >完成</Button
          >
        </template>
        <template v-else>
          <Button variant="secondary" data-action="cancel" @click="close"
            >取消</Button
          >
          <Button
            variant="primary"
            data-action="export"
            :disabled="!plan || loading"
            :loading="exporting"
            @click="exportBackup"
            >导出…</Button
          >
        </template>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.backup-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.lead,
.summary,
.excluded {
  margin: 0;
  color: rgb(var(--text-2));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.loading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.categories {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: var(--r-sm);
  background: rgb(var(--surface-sunken));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
}

.category {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
}

.category + .category {
  box-shadow: inset 0 0.5px 0 var(--stroke-1);
}

.category[data-off] .title,
.category[data-off] .size {
  color: rgb(var(--text-4));
  text-decoration: line-through;
}

.title {
  min-width: 0;
  color: rgb(var(--text-1));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
  overflow-wrap: anywhere;
}

.description {
  grid-column: 1;
  min-width: 0;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  overflow-wrap: anywhere;
}

.size {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.options {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.option {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.hint {
  margin: 0;
  padding-left: var(--space-6);
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  overflow-wrap: anywhere;
}

.passphrase {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-3);
  padding-left: var(--space-6);
}

.excluded-label {
  margin-right: var(--space-1);
  color: rgb(var(--text-1));
  font-weight: var(--weight-medium);
}

.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  color: rgb(var(--text-1));
  font: var(--weight-regular) var(--type-body-sm) var(--font-sans);
  overflow-wrap: anywhere;
}

.result strong {
  font-weight: var(--weight-medium);
}

.where {
  color: rgb(var(--text-2));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
}

.error {
  margin: 0;
  color: rgb(var(--state-error-label));
  font: var(--weight-regular) var(--type-footnote) var(--font-sans);
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
