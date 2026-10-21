<script setup lang="ts">
/**
 * ClaudeApiKeyDialog — 使用 API Key for one Claude Code profile (AGT-12):
 * the user's own Anthropic Console key (ANTHROPIC_API_KEY), billed by use.
 * The field is masked; the key goes to Core once, where it is sealed with
 * Emperor's local key, and is never read back. A Claude account signs in
 * with Claude Code's own login instead (登录 Claude Code), never here.
 * Loaded on demand from 设置 › 子智能体.
 */
import { computed, ref } from 'vue'
import type { ExecutorProbe } from '@emperor/core/runtime-contract'
import Modal from '../ui/Modal.vue'
import Button from '../ui/Button.vue'
import TextField from '../ui/TextField.vue'
import Notice from '../ui/Notice.vue'
import { setExecutorCredential } from '../../api/delegations'

const props = defineProps<{ profileId: string }>()
const emit = defineEmits<{ close: []; saved: [probe: ExecutorProbe] }>()
const key = ref('')
const busy = ref(false)
const error = ref('')
const trimmed = computed(() => key.value.trim())
const problem = computed(() => {
  const value = trimmed.value
  if (!value) return ''
  if (/\s/.test(value)) return 'API Key 不能包含空格或换行。'
  // A Claude account's token is claude's own sign-in, never Emperor's.
  if (/^sk-ant-o[ar]t/i.test(value))
    return '这是 Claude 账号的登录令牌，不是 API Key。Claude 账号请用「登录 Claude Code」登录。'
  if (value.length < 8) return 'API Key 不完整，请粘贴完整的一行。'
  return ''
})
function close(open: boolean) {
  if (open || busy.value) return
  key.value = ''
  emit('close')
}
async function save() {
  if (busy.value || !trimmed.value || problem.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await setExecutorCredential({
      profileId: props.profileId,
      kind: 'api-key',
      token: trimmed.value,
    })
    key.value = ''
    emit('saved', result.probe)
  } catch (cause) {
    error.value = `没有保存：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :open="true" title="使用 API Key" :width="440" @update:open="close">
    <form
      id="claude-api-key-form"
      class="claude-api-key"
      data-claude-api-key-dialog
      autocomplete="off"
      @submit.prevent="save"
    >
      <p class="claude-api-key-step">
        粘贴你在 Anthropic Console 创建的 API
        Key（<code>ANTHROPIC_API_KEY</code>），按用量计费。它优先于 Claude Code
        自己的登录。
      </p>
      <label class="claude-api-key-field"
        >API Key<TextField
          v-model="key"
          type="password"
          monospace
          data-claude-api-key-input
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          :invalid="!!problem"
          placeholder="sk-ant-api03-…"
          aria-label="ANTHROPIC_API_KEY"
      /></label>
      <p
        v-if="problem"
        class="claude-api-key-problem"
        role="alert"
        data-claude-api-key-problem
      >
        {{ problem }}
      </p>
      <p v-else class="claude-api-key-hint">
        只保存在这台 Mac 上，用 Emperor
        的本地密钥加密，保存后立即生效；保存后不会再显示出来。
      </p>
      <Notice v-if="error" tone="error" :title="error" />
    </form>
    <template #footer>
      <Button
        variant="secondary"
        type="button"
        :disabled="busy"
        @click="close(false)"
        >取消</Button
      >
      <Button
        variant="primary"
        type="submit"
        form="claude-api-key-form"
        data-claude-api-key-save
        :disabled="busy || !trimmed || !!problem"
        >{{ busy ? '正在保存…' : '保存' }}</Button
      >
    </template>
  </Modal>
</template>

<style scoped>
.claude-api-key {
  display: grid;
  gap: var(--space-3);
}
.claude-api-key-step,
.claude-api-key-hint,
.claude-api-key-problem {
  margin: 0;
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}
.claude-api-key-hint {
  color: rgb(var(--text-3));
}
.claude-api-key-problem {
  color: rgb(var(--state-error-label));
}
.claude-api-key-step code {
  white-space: nowrap;
  font-family: var(--font-mono);
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
}
.claude-api-key-field {
  display: grid;
  gap: var(--space-1);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}
</style>
