<script setup lang="ts">
/**
 * GitCommitBox — the commit box at the foot of the 审查 pane (UI-S06): the
 * message (⌘↩ commits), 「提交」 (the pane's one primary action) and, once a
 * remote is known, 「提交并推送」. The box always takes input; while the
 * agent runs or a Git operation is unfinished only the buttons wait, and the
 * line beside them says why.
 *
 * Props: attention (a brief accent ring after a focus request).
 * Exposes: focus().
 */
import Button from '../ui/Button.vue'
import TextArea from '../ui/TextArea.vue'
import { computed, ref } from 'vue'
import { injectGitReview } from './useGitReview'

defineProps<{ attention?: boolean }>()

const review = injectGitReview()
const { commitMessage, writesDisabled, blockedReason, canPush, writing } =
  review

const area = ref<InstanceType<typeof TextArea> | null>(null)
const ready = computed(
  () => Boolean(commitMessage.value.trim()) && !writesDisabled.value,
)

function submit(): void {
  if (ready.value) void review.commit()
}

function focus(): void {
  ;(area.value?.$el as HTMLTextAreaElement | undefined)?.focus({
    preventScroll: true,
  })
}

defineExpose({ focus })
</script>

<template>
  <form
    class="git-commit-form"
    :data-attention="attention || undefined"
    @submit.prevent="submit"
  >
    <TextArea
      ref="area"
      v-model="commitMessage"
      class="commit-message"
      aria-label="提交信息"
      placeholder="提交信息（⌘↩ 提交）"
      :min-rows="2"
      :max-rows="8"
      @keydown.meta.enter.prevent="submit"
    />
    <div class="commit-actions">
      <span class="commit-note">{{ blockedReason }}</span>
      <Button
        v-if="canPush"
        size="sm"
        variant="secondary"
        data-action="commit-push"
        :disabled="!ready"
        @click="review.commitAndPush"
        >提交并推送</Button
      >
      <Button
        size="sm"
        variant="primary"
        type="submit"
        :disabled="!ready"
        :loading="writing"
        >提交</Button
      >
    </div>
  </form>
</template>

<style scoped>
.git-commit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.commit-message {
  resize: none;
}

/* A focus request rings the box for a moment. */
.git-commit-form[data-attention] .commit-message {
  box-shadow:
    inset 0 0 0 0.5px rgb(var(--accent) / 0.7),
    0 0 0 3px rgb(var(--accent) / 0.25);
}

.commit-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.commit-note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(var(--text-3));
  font: var(--weight-regular) var(--type-caption) var(--font-sans);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
