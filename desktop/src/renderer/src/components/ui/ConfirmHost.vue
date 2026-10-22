<script setup lang="ts">
/**
 * ConfirmHost — renders the oldest pending confirm() request as a Modal
 * (DS-05). Mounted once in App.vue. 取消, Escape and a mask click answer
 * false; the confirm button answers true. A danger request paints the
 * confirm button red and puts initial focus on 取消, so Enter cannot
 * destroy anything by accident; a default request focuses the confirm
 * button.
 */
import { computed } from 'vue'
import Button from './Button.vue'
import Modal from './Modal.vue'
import { activeConfirm, settleConfirm } from './confirm'

const request = activeConfirm
const open = computed({
  get: () => request.value !== null,
  set: (value) => {
    if (!value && request.value) settleConfirm(request.value.id, false)
  },
})

function answer(confirmed: boolean): void {
  if (request.value) settleConfirm(request.value.id, confirmed)
}
</script>

<template>
  <Modal
    v-if="request"
    :key="request.id"
    v-model:open="open"
    :title="request.title"
    :description="request.body || undefined"
    :width="400"
  >
    <template #footer>
      <Button
        variant="secondary"
        :data-autofocus="request.tone === 'danger' || undefined"
        @click="answer(false)"
        >{{ request.cancelLabel }}</Button
      >
      <Button
        :variant="request.tone === 'danger' ? 'danger' : 'primary'"
        :data-autofocus="request.tone !== 'danger' || undefined"
        @click="answer(true)"
        >{{ request.confirmLabel }}</Button
      >
    </template>
  </Modal>
</template>
