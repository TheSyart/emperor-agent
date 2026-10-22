<script setup lang="ts">
/**
 * HeroProfilePrompt — the profile-interview offer under the composer on an
 * empty chat's hero (UI-S04): 「补充个人偏好 · 用一个简短访谈设置称呼、沟通
 * 方式和工作偏好」 with 开始访谈 and 不再提醒. Only while the interview is
 * pending, a model works (UI-S17: the interview needs one; the first model
 * no longer starts it by itself) and nothing waits for an answer, and only
 * once (profilePrompt.ts: the first such hero keeps it; later chats and
 * later launches do not show it). The interview always stays in 设置 ›
 * 记忆 › 用户档案.
 *
 * Props: sessionId (the chat on screen), blocked? (a takeover card waits).
 */
import { computed } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import Button from '../ui/Button.vue'
import { claimProfilePrompt } from './profilePrompt'

const props = defineProps<{ sessionId: string; blocked?: boolean }>()
const ctx = useAppContext()

const shown = computed(
  () =>
    ctx.boot.value?.profileOnboarding?.status === 'pending' &&
    ctx.boot.value?.modelConfig?.availability?.usable === true &&
    !props.blocked &&
    claimProfilePrompt(props.sessionId),
)

function start(): void {
  void ctx.runSafely(() => ctx.startProfileInterview())
}

function skip(): void {
  void ctx.runSafely(() => ctx.skipProfileInterview())
}
</script>

<template>
  <div v-if="shown" class="hero-profile-prompt" role="status">
    <span class="copy">
      <strong>补充个人偏好</strong>
      <span>用一个简短访谈设置称呼、沟通方式和工作偏好。</span>
    </span>
    <span class="actions">
      <Button size="sm" variant="secondary" @click="start">开始访谈</Button>
      <Button size="sm" @click="skip">不再提醒</Button>
    </span>
  </div>
</template>

<style scoped>
.hero-profile-prompt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2) var(--space-3);
  max-width: var(--composer-card-max);
  margin: 0 auto;
  padding: 0 var(--composer-clearance);
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-3));
}

.copy {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: var(--space-2);
  min-width: 0;
}

.copy strong {
  color: rgb(var(--text-1));
  font-weight: var(--weight-medium);
}

.actions {
  display: inline-flex;
  gap: var(--space-1);
}
</style>
