<script setup lang="ts">
/**
 * ConnectionKeyDialog — 更换 Key for one connection (MOD-05): the new key
 * goes to every model on it through one `model.updateConnection`, after a
 * confirmation that says how many models change. The saved key shows only
 * by its last 4 characters; a key that can no longer be opened says so.
 *
 * Props: open (v-model), label (provider name), entries (the connection's
 * models; the first one names it to Core).
 * Emits: saved(payload) after Core changed the key.
 */
import { computed, ref, watch } from 'vue'
import { core } from '../../../api/http'
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import Button from '../../ui/Button.vue'
import { confirm } from '../../ui/confirm'
import Modal from '../../ui/Modal.vue'
import { Field, TextField } from '../ui'
import { keyTail } from './modelListModel'

const props = defineProps<{ label: string; entries: readonly ModelEntry[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [payload: ModelConfigPayload] }>()

const key = ref('')
const saving = ref(false)
const error = ref('')

const tail = computed(() => keyTail(props.entries))
const lost = computed(() =>
  props.entries.some((entry) => entry.credentialState === 'needs_reentry'),
)

watch(open, (value) => {
  if (!value) return
  key.value = ''
  error.value = ''
})

async function save(): Promise<void> {
  const lead = props.entries[0]
  const apiKey = key.value.trim()
  if (!lead || !apiKey || saving.value) return
  const count = props.entries.length
  if (
    !(await confirm({
      title: `更换「${props.label}」的 Key？`,
      body: `将同时更新 ${count} 个模型，它们都会改用新的 Key。`,
      confirmLabel: '更新',
    }))
  )
    return
  saving.value = true
  error.value = ''
  try {
    const payload = await core('model.updateConnection', {
      entryId: lead.entryId,
      apiKey,
    })
    emit('saved', payload)
    open.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal v-model:open="open" :title="`更换 ${label} 的 Key`" :width="440">
    <form
      class="connection-dialog"
      data-testid="connection-key-dialog"
      @submit.prevent="save"
    >
      <Field
        label="API Key"
        :hint="
          [
            tail ? `当前 ${tail}` : '',
            lost
              ? '保存这个 Key 的本机密钥已不可用，请重新填写'
              : '这个连接下的所有模型都会改用新 Key',
          ]
            .filter(Boolean)
            .join('；')
        "
        :error="error"
      >
        <TextField
          v-model="key"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="输入新的 API Key"
          data-autofocus
        />
      </Field>
      <div class="actions">
        <Button variant="secondary" type="button" @click="open = false"
          >取消</Button
        >
        <Button
          variant="primary"
          type="submit"
          :disabled="!key.trim() || saving"
          >{{ saving ? '更新中…' : '更新' }}</Button
        >
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.connection-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
