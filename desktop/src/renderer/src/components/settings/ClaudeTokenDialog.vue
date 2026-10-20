<script setup lang="ts">
/**
 * ClaudeTokenDialog — 设置令牌 for one Claude Code profile (AGT-02): the
 * long-lived token `claude setup-token` prints for a subscription, or an
 * ANTHROPIC_API_KEY. The field is masked; the token goes to Core once,
 * where it is sealed with Emperor's local key, and is never read back.
 * Loaded on demand from 设置 › 子智能体.
 */
import { computed, ref } from 'vue'
import type { ExecutorProbe } from '@emperor/core/runtime-contract'
import Modal from '../ui/Modal.vue'
import Button from '../ui/Button.vue'
import TextField from '../ui/TextField.vue'
import Segmented from '../ui/Segmented.vue'
import Notice from '../ui/Notice.vue'
import { setExecutorCredential } from '../../api/delegations'

const props = defineProps<{
  profileId: string
  kind?: 'oauth-token' | 'api-key'
}>()
const emit = defineEmits<{ close: []; saved: [probe: ExecutorProbe] }>()
const kind = ref<'oauth-token' | 'api-key'>(props.kind ?? 'oauth-token')
const token = ref('')
const busy = ref(false)
const error = ref('')
const KINDS = [
  { value: 'oauth-token' as const, label: '订阅账号' },
  { value: 'api-key' as const, label: 'API Key' },
]
const trimmed = computed(() => token.value.trim())
/** A token pasted under the other kind would be sent as the wrong variable. */
const problem = computed(() => {
  const value = trimmed.value
  if (!value) return ''
  if (/\s/.test(value)) return '令牌不能包含空格或换行。'
  if (kind.value === 'api-key' && value.startsWith('sk-ant-oat'))
    return '这是订阅账号的令牌（sk-ant-oat…），请选择「订阅账号」。'
  if (kind.value === 'oauth-token' && value.startsWith('sk-ant-api'))
    return '这是 API Key（sk-ant-api…），请选择「API Key」。'
  if (value.length < 8) return '令牌不完整，请粘贴完整的一行。'
  return ''
})
function close(open: boolean) {
  if (open || busy.value) return
  token.value = ''
  emit('close')
}
async function save() {
  if (busy.value || !trimmed.value || problem.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await setExecutorCredential({
      profileId: props.profileId,
      kind: kind.value,
      token: trimmed.value,
    })
    token.value = ''
    emit('saved', result.probe)
  } catch (cause) {
    error.value = `没有保存：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    :open="true"
    title="设置 Claude Code 令牌"
    :width="440"
    @update:open="close"
  >
    <form
      id="claude-token-form"
      class="claude-token"
      data-claude-token-dialog
      autocomplete="off"
      @submit.prevent="save"
    >
      <Segmented
        v-model="kind"
        :options="KINDS"
        block
        size="md"
        aria-label="令牌类型"
      />
      <p class="claude-token-step">
        <template v-if="kind === 'oauth-token'"
          >在终端运行
          <code>claude setup-token</code>，把生成的令牌粘贴到这里。</template
        ><template v-else
          >粘贴 ANTHROPIC_API_KEY，可在 Anthropic Console 创建。</template
        >
      </p>
      <label class="claude-token-field"
        >{{ kind === 'oauth-token' ? '令牌' : 'API Key'
        }}<TextField
          v-model="token"
          type="password"
          monospace
          data-claude-token-input
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          :invalid="!!problem"
          :placeholder="
            kind === 'oauth-token' ? 'sk-ant-oat01-…' : 'sk-ant-api03-…'
          "
          :aria-label="
            kind === 'oauth-token' ? 'Claude Code 令牌' : 'ANTHROPIC_API_KEY'
          "
      /></label>
      <p
        v-if="problem"
        class="claude-token-problem"
        role="alert"
        data-claude-token-problem
      >
        {{ problem }}
      </p>
      <p v-else class="claude-token-hint">
        只保存在这台 Mac 上，用 Emperor
        的本地密钥加密，保存后立即生效；不会显示出来，也不读取钥匙串。
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
        form="claude-token-form"
        data-claude-token-save
        :disabled="busy || !trimmed || !!problem"
        >{{ busy ? '正在保存…' : '保存' }}</Button
      >
    </template>
  </Modal>
</template>

<style scoped>
.claude-token {
  display: grid;
  gap: var(--space-3);
}
.claude-token-step,
.claude-token-hint,
.claude-token-problem {
  margin: 0;
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}
.claude-token-hint {
  color: rgb(var(--text-3));
}
.claude-token-problem {
  color: rgb(var(--state-error-label));
}
.claude-token-step code {
  white-space: nowrap;
  font-family: var(--font-mono);
  padding: 0 var(--space-1);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
}
.claude-token-field {
  display: grid;
  gap: var(--space-1);
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  color: rgb(var(--text-2));
}
</style>
