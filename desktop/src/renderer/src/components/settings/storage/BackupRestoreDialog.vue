<script setup lang="ts">
/**
 * BackupRestoreDialog — 从备份恢复 (REL-03), for a backup main already
 * unzipped and checked. It says when and by which Emperor the backup was
 * made, which parts it replaces, and that the current data is moved aside
 * first; with a sealed 密码管理器 in it, the backup passphrase (left empty,
 * the vault is not restored). 恢复并重新启动: main imports the vault (a
 * wrong passphrase changes nothing and can be typed again), schedules the
 * restore and restarts. Closing without restoring throws the opened
 * backup away.
 *
 * Props: open (v-model), backup (what main opened).
 */
import { computed, ref, watch } from 'vue'
import {
  discardHomeBackup,
  restoreHomeBackup,
  type HomeBackupView,
} from '../../../api/homeBackup'
import Button from '../../ui/Button.vue'
import Field from '../../ui/Field.vue'
import Modal from '../../ui/Modal.vue'
import Notice from '../../ui/Notice.vue'
import TextField from '../../ui/TextField.vue'
import { formatStorageBytes } from './storageModel'
import {
  BACKUP_CATEGORY_TITLES,
  backupErrorText,
  backupTime,
} from './backupModel'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ backup: HomeBackupView }>()

const passphrase = ref('')
const restoring = ref(false)
const restarting = ref(false)
const error = ref('')

const parts = computed(() =>
  props.backup.categories.map((id) => BACKUP_CATEGORY_TITLES[id] ?? id),
)

async function restore(): Promise<void> {
  if (restoring.value || restarting.value) return
  restoring.value = true
  error.value = ''
  try {
    await restoreHomeBackup(
      props.backup.id,
      props.backup.credentials && passphrase.value
        ? passphrase.value
        : undefined,
    )
    passphrase.value = ''
    restarting.value = true
  } catch (cause) {
    error.value = backupErrorText(cause)
  } finally {
    restoring.value = false
  }
}

function close(): void {
  if (!restarting.value) open.value = false
}

// However it closes (取消, Esc, the mask), an unrestored backup is dropped.
watch(open, (value, before) => {
  if (!value && before && !restarting.value) {
    passphrase.value = ''
    void discardHomeBackup(props.backup.id)
  }
})
</script>

<template>
  <Modal
    v-model:open="open"
    title="从备份恢复"
    :width="520"
    :closable="!restarting"
    :close-on-mask="!restarting"
  >
    <div class="restore-dialog" data-testid="backup-restore-dialog">
      <div class="source">
        <span class="name">{{ backup.name }}</span>
        <span class="meta"
          >备份于 {{ backupTime(backup.createdAt) }} · Emperor
          {{ backup.appVersion }} · {{ backup.files }} 个文件，约
          {{ formatStorageBytes(backup.bytes) }}</span
        >
      </div>
      <Notice
        v-if="backup.newer"
        tone="info"
        title="这个备份来自更新版本的 Emperor"
        :description="`恢复后，由 Emperor ${backup.appVersion} 写入的文件在当前版本里只读。`"
      />
      <div class="replaces">
        <span class="label">会替换</span>
        <ul class="parts">
          <li v-for="part in parts" :key="part">{{ part }}</li>
        </ul>
      </div>
      <p class="lead">
        Emperor 会先把当前数据移到 Emperor Home 的 migrations
        文件夹（backup-日期时间），然后重新启动并完成恢复。浏览器登录资料、日志和本地密钥不会改动。
      </p>
      <Field
        v-if="backup.credentials"
        label="备份口令"
        hint="填写后同时恢复密码管理器；留空则不恢复凭据。"
      >
        <TextField
          v-model="passphrase"
          type="password"
          autocomplete="off"
          :disabled="restarting"
        />
      </Field>
      <p v-if="restarting" class="restarting" role="status">
        正在重新启动 Emperor…
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="actions">
        <Button
          variant="secondary"
          data-action="cancel"
          :disabled="restarting"
          @click="close"
          >取消</Button
        >
        <Button
          variant="danger"
          data-action="restore"
          :disabled="restarting"
          :loading="restoring"
          @click="restore"
          >恢复并重新启动</Button
        >
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.restore-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.source {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  padding: var(--space-2-5) var(--space-3);
  border-radius: var(--r-sm);
  background: rgb(var(--surface-sunken));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  min-width: 0;
}

.name {
  color: rgb(var(--text-1));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
  overflow-wrap: anywhere;
}

.meta {
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  overflow-wrap: anywhere;
}

.replaces {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}

.label {
  color: rgb(var(--text-1));
  font: var(--weight-medium) var(--type-footnote) var(--font-sans);
}

.parts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin: 0;
  padding: 0;
  list-style: none;
}

.parts li {
  padding: 0 var(--space-2);
  border-radius: var(--r-full);
  background: rgb(var(--surface-raised));
  box-shadow: inset 0 0 0 0.5px var(--stroke-2);
  color: rgb(var(--text-2));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  line-height: var(--control-xs);
}

.lead,
.restarting {
  margin: 0;
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
