<script setup lang="ts">
import { computed } from 'vue'
import type { ControlInteraction, RuntimePlanRecord } from '../../types'
import MarkdownBlock from './MarkdownBlock.vue'
import { planDisplayMarkdown, planStatusPresentation } from './planDisplay'

const props = defineProps<{
  interaction: ControlInteraction
  plan?: RuntimePlanRecord | null
}>()

const comments = computed(() => props.interaction.comments || [])
const presentation = computed(() =>
  planStatusPresentation(props.interaction, props.plan || null),
)
const markdownContent = computed(() =>
  planDisplayMarkdown(props.interaction, props.plan || null),
)
</script>

<template>
  <section
    class="control-card plan-card plan-large-card"
    :class="props.interaction.status"
    :data-tone="presentation.tone"
  >
    <header class="plan-card-hero">
      <div class="plan-card-kicker">计划提案</div>
      <div class="plan-card-title-row">
        <strong>{{
          props.interaction.title || props.plan?.title || '待批准计划'
        }}</strong>
        <div class="plan-card-chips">
          <em>{{ presentation.label }}</em>
          <em>{{ presentation.risk }}</em>
        </div>
      </div>
    </header>

    <p v-if="props.interaction.summary" class="control-context">
      {{ props.interaction.summary }}
    </p>

    <div class="plan-markdown plan-markdown-primary">
      <MarkdownBlock :content="markdownContent" />
    </div>

    <div v-if="props.interaction.assumptions?.length" class="plan-assumptions">
      <span>Assumptions</span>
      <ul>
        <li v-for="item in props.interaction.assumptions" :key="item">
          {{ item }}
        </li>
      </ul>
    </div>

    <div v-if="comments.length" class="plan-comments">
      <span>评论历史</span>
      <p v-for="item in comments" :key="`${item.timestamp}-${item.content}`">
        {{ item.content }}
      </p>
    </div>

    <footer class="control-footnote">
      状态：{{ props.interaction.status }}
    </footer>
  </section>
</template>
