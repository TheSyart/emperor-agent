<script setup lang="ts">
/**
 * AppIdDialog — adds one app to a computer use app list by its bundle ID
 * (found in the app's Info.plist or 系统信息 › 应用程序). Rejects anything
 * that is not a bundle ID before it reaches Core.
 *
 * Props: open (v-model:open), title, description?, busy?.
 * Emits: save(bundleId).
 */
import { ref, watch } from 'vue'
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'
import { Field, TextField } from '../ui'

const props = withDefaults(
  defineProps<{ title: string; description?: string; busy?: boolean }>(),
  { description: undefined, busy: false },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ save: [bundleId: string] }>()

const APP_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const draft = ref('')
const error = ref('')

watch(open, (value) => {
  if (!value) return
  draft.value = ''
  error.value = ''
})

function submit(): void {
  const id = draft.value.trim()
  if (!APP_IDENTITY.test(id)) {
    error.value = '请输入应用的 bundle ID，例如 com.example.App'
    return
  }
  emit('save', id)
  open.value = false
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="props.title"
    :description="props.description"
    :width="420"
  >
    <form id="app-id-form" class="app-id-form" @submit.prevent="submit">
      <Field
        label="bundle ID"
        :error="error || undefined"
        hint="在应用的 Info.plist 或「系统信息 › 应用程序」中可以找到"
      >
        <TextField
          v-model="draft"
          monospace
          placeholder="com.example.App"
          spellcheck="false"
          autocomplete="off"
          :invalid="error !== ''"
        />
      </Field>
    </form>
    <template #footer>
      <Button variant="outline" type="button" @click="open = false"
        >取消</Button
      >
      <Button
        variant="primary"
        type="submit"
        form="app-id-form"
        :disabled="busy || !draft.trim()"
        >添加</Button
      >
    </template>
  </Modal>
</template>

<style scoped>
.app-id-form {
  display: grid;
  gap: var(--space-3);
}
</style>
