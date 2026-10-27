<script setup lang="ts">
/**
 * GroupResultCard — the result card of a task Claude Code or Codex did in
 * an isolated copy (GRP-09, GRP-08): the very card a conversation shows
 * (「Codex 改了 N 个文件 · 查看差异 · 应用到项目 · 丢弃」), read from the
 * delegation the result message names. The delegation belongs to the
 * member's own session, so the card acts there. Read again when the
 * delegation changes (applied, discarded, undone). Nothing when the run
 * changed no file.
 *
 * Props: delegation ({ id, runId }); sessionId (the member's session).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onCoreEvent } from '../../api/backend'
import { getDelegation } from '../../api/delegations'
import type {
  DelegationResultChatData,
  DelegationResultChatNode,
} from '../../conversation/types'
import {
  createExpansionStore,
  provideChatContext,
} from '../conversation/chatContext'
import DelegationResultCard from '../conversation/nodes/DelegationResultCard.vue'

const props = defineProps<{
  delegation: { id: string; runId: string }
  sessionId: string
}>()

provideChatContext({
  actions: {
    inspect: () => undefined,
    openSubagent: () => undefined,
    editMessage: () => undefined,
  },
  expansion: createExpansionStore(),
  sessionId: () => props.sessionId,
  rootSessionId: () => props.sessionId,
})

interface ResultRecord {
  state: DelegationResultChatData['state']
  files: DelegationResultChatData['files']
  totals: DelegationResultChatData['totals']
  truncated?: boolean
  conflicts?: string[]
  at: number
  by?: 'user' | 'model'
  undo?: unknown
  reverted?: DelegationResultChatData['reverted']
}

const data = ref<DelegationResultChatData | null>(null)
let generation = 0

async function load(): Promise<void> {
  const run = ++generation
  try {
    const state = (await getDelegation({
      id: props.delegation.id,
      sessionId: props.sessionId,
    })) as unknown as {
      record?: {
        id: string
        backend: 'claude-code' | 'codex'
        startSpec?: { description?: string }
      }
      runs?: Record<string, { result?: ResultRecord }>
    }
    if (run !== generation) return
    const record = state.record
    const result = state.runs?.[props.delegation.runId]?.result
    data.value =
      record && result
        ? {
            delegationId: record.id,
            runId: props.delegation.runId,
            backend: record.backend,
            ...(record.startSpec?.description
              ? { title: record.startSpec.description }
              : {}),
            state: result.state,
            files: result.files,
            totals: result.totals,
            truncated: result.truncated === true,
            conflicts: result.conflicts ?? [],
            at: result.at,
            ...(result.by ? { by: result.by } : {}),
            undoable: result.state === 'applied' && Boolean(result.undo),
            verifyFirst: false,
            ...(result.reverted ? { reverted: result.reverted } : {}),
          }
        : null
  } catch {
    if (run === generation) data.value = null
  }
}

watch(
  () => [props.delegation.id, props.delegation.runId, props.sessionId],
  () => void load(),
  { immediate: true },
)

let timer: ReturnType<typeof setTimeout> | null = null
const unsubscribe = onCoreEvent((input) => {
  const event = input as { event?: string; delegation_id?: string } | null
  if (
    !event?.event?.startsWith('delegation_') ||
    event.delegation_id !== props.delegation.id
  )
    return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void load()
  }, 80)
})
onBeforeUnmount(() => {
  unsubscribe()
  if (timer) clearTimeout(timer)
})

const node = computed<DelegationResultChatNode | null>(() =>
  data.value && data.value.totals.files > 0
    ? {
        key: `group-result:${data.value.runId}`,
        kind: 'delegationResult',
        id: data.value.delegationId,
        target: 'chat',
        anchorSeq: 0,
        visibility: 'visible',
        turn: null,
        step: null,
        data: data.value,
      }
    : null,
)
</script>

<template>
  <DelegationResultCard v-if="node" class="group-result" :node="node" />
</template>

<style scoped>
.group-result {
  max-width: 640px;
  margin-top: var(--space-1-5);
}
</style>
