<script setup lang="ts">
/** Routine New/Edit deep links become a role-creator chat with intent. */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ROLE_CREATOR_CONTACT_ID } from '@emperor/core/runtime-contract'
import { core } from '../../api/http'
import { useSession } from '../../composables/useSession'
import Button from '../ui/Button.vue'
import Spinner from '../ui/Spinner.vue'
import { failureText } from './contactEditorModel'

const route = useRoute()
const router = useRouter()
const sessions = useSession()
const error = ref('')
let run = 0

watch(
  () => route.fullPath,
  async () => {
    const current = ++run
    error.value = ''
    const edit = route.name === 'contact-edit'
    const targetId = String(route.params.id ?? '')
    try {
      const session = await core('contacts.openChat', {
        id: ROLE_CREATOR_CONTACT_ID,
        intent: edit ? { action: 'edit', targetId } : { action: 'create' },
      })
      if (current !== run) return
      sessions.adopt(session)
      await router.replace({ name: 'chat', params: { sessionId: session.id } })
    } catch (failure) {
      if (current === run) error.value = failureText(failure)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="creator-entry" data-contact-creator-entry>
    <p v-if="!error" role="status"><Spinner size="sm" />正在打开角色创建师…</p>
    <template v-else>
      <p role="alert">{{ error }}</p>
      <Button
        size="sm"
        variant="secondary"
        @click="router.push({ name: 'contacts' })"
      >
        返回联系人
      </Button>
    </template>
  </div>
</template>

<style scoped>
.creator-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: 240px;
  padding: var(--space-6);
  color: rgb(var(--text-2));
  font-size: var(--fs-xs);
}
.creator-entry p {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
}
</style>
