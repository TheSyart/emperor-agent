<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronsUpDown, Copy } from 'lucide-vue-next'
import type { ControlInteraction, RuntimePlanRecord } from '../../types'
import MarkdownBlock from './MarkdownBlock.vue'
import { planDisplayMarkdown, planStatusPresentation } from './planDisplay'

const props = defineProps<{
  interaction: ControlInteraction
  plan?: RuntimePlanRecord | null
}>()

const copied = ref(false)
const collapsed = ref(false)

const comments = computed(() => props.interaction.comments || [])
const presentation = computed(() =>
  planStatusPresentation(props.interaction, props.plan || null),
)
const markdownContent = computed(() =>
  planDisplayMarkdown(props.interaction, props.plan || null),
)

async function copyPlan(): Promise<void> {
  const text = markdownContent.value
  if (!text) return
  await navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1400)
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section
    class="control-card plan-card plan-large-card"
    :class="props.interaction.status"
    :data-tone="presentation.tone"
  >
    <header class="plan-card-hero">
      <div class="plan-card-hero-top">
        <div class="plan-card-kicker">计划提案</div>
        <div class="plan-card-actions">
          <button
            type="button"
            class="plan-card-icon-button"
            :aria-label="copied ? '已复制' : '复制计划'"
            @click="copyPlan"
          >
            <Check v-if="copied" :size="14" />
            <Copy v-else :size="14" />
          </button>
          <button
            type="button"
            class="plan-card-icon-button"
            :class="{ active: collapsed }"
            :aria-label="collapsed ? '展开计划正文' : '收起计划正文'"
            :aria-expanded="!collapsed"
            @click="toggleCollapsed"
          >
            <ChevronsUpDown :size="14" />
          </button>
        </div>
      </div>
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

    <div
      class="plan-markdown plan-markdown-primary"
      :class="{ 'plan-markdown-collapsed': collapsed }"
    >
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
  </section>
</template>
