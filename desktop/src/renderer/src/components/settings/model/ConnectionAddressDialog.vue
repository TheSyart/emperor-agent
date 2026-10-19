<script setup lang="ts">
/**
 * ConnectionAddressDialog — 编辑地址 for one connection (MOD-05): a new API
 * address for every model on it (`model.updateConnection`). The key stays.
 *
 * Props: open (v-model), label (provider name), entries (the connection's
 * models; the first one names it to Core).
 * Emits: saved(payload).
 */
import { computed, ref, watch } from 'vue'
import { core } from '../../../api/http'
import type { ModelConfigPayload, ModelEntry } from '../../../types'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { Field, TextField } from '../ui'

const props = defineProps<{ label: string; entries: readonly ModelEntry[] }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [payload: ModelConfigPayload] }>()

const address = ref('')
const saving = ref(false)
const error = ref('')

const lead = computed(() => props.entries[0] ?? null)
const changed = computed(
  () =>
    Boolean(address.value.trim()) &&
    address.value.trim() !== (lead.value?.apiBase ?? ''),
)
const resource = computed(() =>
  lead.value?.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions',
)

watch(
  open,
  (value) => {
    if (!value) return
    address.value = lead.value?.apiBase ?? ''
    error.value = ''
  },
  { immediate: true },
)

async function save(): Promise<void> {
  if (!lead.value || !changed.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const payload = await core('model.updateConnection', {
      entryId: lead.value.entryId,
      apiBase: address.value.trim(),
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
  <Modal v-model:open="open" :title="`编辑 ${label} 的地址`" :width="480">
    <form
      class="connection-dialog"
      data-testid="connection-address-dialog"
      @submit.prevent="save"
    >
      <Field
        label="API 地址"
        :hint="`base URL，或完整的 ${resource} 地址；这个连接下的 ${entries.length} 个模型都会改用它`"
        :error="error"
      >
        <TextField
          v-model="address"
          type="url"
          monospace
          spellcheck="false"
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
          :disabled="!changed || saving"
          >{{ saving ? '保存中…' : '保存' }}</Button
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
