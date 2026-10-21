<script setup lang="ts">
/**
 * 登录 Claude Code while Core runs it, or after it failed (FIX-11), on the
 * main page and on 详情 › 登录:
 *
 * - running: 「正在浏览器中登录 Claude Code…」 and 取消 (Core ends claude's
 *   process group); the result arrives by itself;
 * - failed: why (from how claude ended, never from what it printed), and
 *   the same sign-in as one line to run in Terminal, with 复制命令 and
 *   重新检测.
 */
import { ref } from 'vue'
import type { ClaudeSignInView } from '@emperor/core/runtime-contract'
import Button from '../../ui/Button.vue'
import { writeClipboard } from '../../ui/useCopyFeedback'
import { Notice } from '../ui'
import { signInFailureText } from './executorText'

const props = defineProps<{ signIn: ClaudeSignInView; busy?: boolean }>()
const emit = defineEmits<{ cancel: []; recheck: [] }>()

const copied = ref(false)
async function copyCommand() {
  if (props.signIn.command)
    copied.value = await writeClipboard(props.signIn.command)
}
</script>

<template>
  <Notice
    v-if="signIn.state === 'running'"
    tone="info"
    title="正在浏览器中登录 Claude Code…"
    data-claude-sign-in-pending
  >
    在浏览器里完成后会自动回来。
    <template #actions>
      <Button
        size="sm"
        variant="secondary"
        data-claude-sign-in-cancel
        @click="emit('cancel')"
        >取消</Button
      >
    </template>
  </Notice>
  <Notice
    v-else-if="signIn.state === 'failed'"
    tone="warn"
    :title="signInFailureText(signIn)"
    data-claude-sign-in-failed
  >
    <span v-if="signIn.command" class="fallback"
      >也可以在「终端」里运行下面这行命令自己登录，完成后点「重新检测」。</span
    >
    <code v-if="signIn.command" class="command" data-claude-sign-in-command>{{
      signIn.command
    }}</code>
    <template #actions>
      <Button
        v-if="signIn.command"
        size="sm"
        variant="secondary"
        data-claude-sign-in-copy
        @click="copyCommand"
        >{{ copied ? '已复制' : '复制命令' }}</Button
      ><Button
        size="sm"
        variant="ghost"
        data-claude-sign-in-recheck
        :disabled="busy"
        @click="emit('recheck')"
        >重新检测</Button
      >
    </template>
  </Notice>
</template>

<style scoped>
.fallback {
  display: block;
}
.command {
  display: block;
  margin-top: var(--space-1-5);
  overflow-x: auto;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--r-xs);
  background: rgb(var(--surface-sunken));
  color: rgb(var(--text-1));
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  white-space: nowrap;
}
</style>
