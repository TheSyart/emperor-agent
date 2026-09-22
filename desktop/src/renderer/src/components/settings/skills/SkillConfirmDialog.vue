<script setup lang="ts">
/**
 * SkillConfirmDialog — the one confirmation step Settings › Skills needs
 * (delete a Skill, delete an invalid Skill folder, overwrite a personal copy):
 * a 380px ui/Modal with the question, an optional detail line (a path) and
 * 取消 / confirm. Escape closes only this dialog (ui/Modal's modal stack).
 *
 * Props: title, description?, detail? (monospace line), confirmLabel,
 * danger? (red confirm), busy? (disables both buttons).
 * v-model:open. Emits: confirm.
 */
import Button from '../../ui/Button.vue'
import Modal from '../../ui/Modal.vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    detail?: string
    confirmLabel?: string
    danger?: boolean
    busy?: boolean
  }>(),
  {
    description: undefined,
    detail: undefined,
    confirmLabel: '确定',
    danger: false,
    busy: false,
  },
)
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <Modal
    v-model:open="open"
    :title="title"
    :description="description"
    :close-on-mask="!busy"
    :closable="!busy"
  >
    <p v-if="detail" class="detail">{{ detail }}</p>
    <template #footer>
      <Button variant="outline" :disabled="busy" @click="open = false">
        取消
      </Button>
      <Button
        :variant="danger ? 'danger' : 'primary'"
        :disabled="busy"
        data-action="confirm"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.detail {
  margin: 0;
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-row);
  background: rgb(var(--code-block-bg));
  font-family: var(--font-mono);
  font-size: var(--fs-xxs);
  line-height: var(--lh-xxs);
  color: rgb(var(--label-secondary));
  overflow-wrap: anywhere;
}
</style>
