<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ControlInteraction } from '../../types'
import { useAppContext } from '../../composables/useAppContext'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ interaction: ControlInteraction }>()
const ctx = useAppContext()
const comment = ref('')

const waiting = computed(() => props.interaction.status === 'waiting')
const comments = computed(() => props.interaction.comments || [])
const riskLabel = computed(() => {
  if (props.interaction.risk_level === 'high') return '高风险'
  if (props.interaction.risk_level === 'low') return '低风险'
  return '中风险'
})

function approve() {
  ctx.approvePlan(props.interaction.id)
}

function sendComment() {
  const text = comment.value.trim()
  if (!text) return
  if (ctx.sendPlanComment(props.interaction.id, text)) comment.value = ''
}

function cancel() {
  ctx.cancelInteraction(props.interaction.id)
}
</script>

<template>
  <section class="control-card plan-card" :class="props.interaction.status">
    <header class="control-card-head">
      <span>Plan Preview</span>
      <strong>{{ props.interaction.title || '待批准计划' }}</strong>
      <em>{{ riskLabel }}</em>
    </header>
    <p v-if="props.interaction.summary" class="control-context">{{ props.interaction.summary }}</p>

    <div class="plan-markdown">
      <MarkdownBlock :content="props.interaction.plan_markdown || ''" />
    </div>

    <div v-if="props.interaction.assumptions?.length" class="plan-assumptions">
      <span>Assumptions</span>
      <ul>
        <li v-for="item in props.interaction.assumptions" :key="item">{{ item }}</li>
      </ul>
    </div>

    <div v-if="comments.length" class="plan-comments">
      <span>评论历史</span>
      <p v-for="item in comments" :key="`${item.timestamp}-${item.content}`">{{ item.content }}</p>
    </div>

    <footer v-if="waiting" class="plan-action-zone">
      <textarea v-model="comment" rows="3" placeholder="写下修改意见，Agent 会据此重出计划" />
      <div class="control-actions">
        <button class="control-secondary" type="button" @click="cancel">取消</button>
        <button class="control-secondary" type="button" :disabled="!comment.trim()" @click="sendComment">提交评论</button>
        <button class="control-primary" type="button" @click="approve">批准执行</button>
      </div>
    </footer>
    <footer v-else class="control-footnote">状态：{{ props.interaction.status }}</footer>
  </section>
</template>
