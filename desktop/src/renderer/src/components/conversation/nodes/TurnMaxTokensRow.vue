<script setup lang="ts">
/** TurnMaxTokensRow — the turn stopped at the output-token cap (warn). */
import type { TurnMaxTokensChatNode } from '../../../conversation/types'
import NoticeRow from './NoticeRow.vue'

defineProps<{ node: TurnMaxTokensChatNode }>()
</script>

<template>
  <NoticeRow
    state="warn"
    title="已达到输出上限"
    message="回复在输出 token 上限处被截断，可以让我继续。"
  />
</template>
