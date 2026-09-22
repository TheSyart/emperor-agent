<script setup lang="ts">
/** TurnErrorRow — terminal turn failure (dsh TurnErrorItem). */
import type { TurnErrorChatNode } from '../../../conversation/types'
import NoticeRow from './NoticeRow.vue'

defineProps<{ node: TurnErrorChatNode }>()
</script>

<template>
  <NoticeRow
    state="error"
    title="本轮失败"
    :message="node.data.message"
    :code="
      node.data.status !== undefined
        ? `${node.data.code} · ${node.data.status}`
        : node.data.code
    "
  />
</template>
