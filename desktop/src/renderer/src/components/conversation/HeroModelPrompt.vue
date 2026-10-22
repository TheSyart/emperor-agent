<script setup lang="ts">
/**
 * HeroModelPrompt — the row under an empty chat's composer while no model
 * works (UI-S17). With no model at all: 「还没有可用模型 · 接入一个模型后就能
 * 开始对话。」 and 开始接入, which opens the first-run guide (also after it
 * was put off). With a model that cannot run: Core's reason (a missing or
 * unreadable key, no active entry, …) and 去处理 (设置 › 模型).
 */
import { computed } from 'vue'
import { useAppContext } from '../../composables/useAppContext'
import { heroModelState } from '../onboarding/firstRunGate'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import Button from '../ui/Button.vue'
import Dot from '../ui/Dot.vue'

const ctx = useAppContext()
const settingsRoute = useSettingsRoute()
const state = computed(() => heroModelState(ctx.boot.value))
</script>

<template>
  <div
    v-if="state"
    class="hero-model-prompt"
    role="status"
    :data-kind="state.kind"
  >
    <template v-if="state.kind === 'setup'">
      <span class="copy">
        <strong>还没有可用模型</strong>
        <span>接入一个模型后就能开始对话。</span>
      </span>
      <Button size="sm" variant="secondary" @click="ctx.openModelSetup()"
        >开始接入</Button
      >
    </template>
    <template v-else>
      <span class="copy">
        <Dot state="attention" size="sm" />
        <span>{{ state.message }}</span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        @click="settingsRoute.openSettings('model')"
        >去处理</Button
      >
    </template>
  </div>
</template>

<style scoped>
.hero-model-prompt {
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
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-width: 0;
}

.copy strong {
  color: rgb(var(--text-1));
  font-weight: var(--weight-medium);
}
</style>
