<script setup lang="ts">
/**
 * WorkspaceWaitLine — under a tool row whose write has waited 10 seconds
 * for a subagent working in the project itself (AGT-06): 「正在等待子智能体
 * 释放工作区 · 停止它」. 停止它 stops that subagent's run; the write then
 * goes on by itself.
 *
 * Props: wait (WorkspaceWait).
 */
import { ref } from 'vue'
import { Hourglass } from 'lucide-vue-next'
import { interruptDelegation } from '../../../api/delegations'
import LinkButton from '../../ui/LinkButton.vue'
import type { WorkspaceWait } from './workspaceWaits'

const props = defineProps<{ wait: WorkspaceWait }>()
const stopping = ref(false)
const error = ref('')

async function stop(): Promise<void> {
  if (stopping.value) return
  stopping.value = true
  error.value = ''
  try {
    await interruptDelegation({
      id: props.wait.delegationId,
      runId: props.wait.runId,
      sessionId: props.wait.sessionId,
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    stopping.value = false
  }
}
</script>

<template>
  <div class="wait-line" data-workspace-wait role="status">
    <span class="leading"><Hourglass :size="14" aria-hidden="true" /></span>
    <span class="text">正在等待子智能体释放工作区</span>
    <span v-if="wait.title" class="holder">{{ wait.title }}</span>
    <span class="sep" aria-hidden="true">·</span>
    <LinkButton data-stop-holder :disabled="stopping" @click="stop">{{
      stopping ? '正在停止…' : '停止它'
    }}</LinkButton>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.wait-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  min-height: var(--control-sm);
  color: rgb(var(--text-2));
  font: var(--type-footnote) var(--font-sans);
}

.leading {
  display: inline-flex;
  width: var(--icon-md);
  justify-content: center;
  color: rgb(var(--attention));
}

.holder {
  overflow: hidden;
  max-width: 24ch;
  color: rgb(var(--text-3));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  color: rgb(var(--text-4));
}

.error {
  color: rgb(var(--error));
}
</style>
