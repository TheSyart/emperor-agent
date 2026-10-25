<script setup lang="ts">
/**
 * A failure for the CLI's version (VER-06, preview § 8), under a failed
 * Claude Code / Codex row and as the external agent page's banner: why,
 * the last good version, then 退回 x / 装 x（已验证） (both open their
 * confirmation in 设置 › 子智能体 — nothing runs from here), 打开设置 (that
 * executor's page) and 重新检查 (the offline self-check, now).
 *
 * Props: context (the run's VersionFailureContext), variant ('row' |
 * 'banner').
 */
import { computed, onMounted } from 'vue'
import type { VersionFailureContext } from '@emperor/core/runtime-contract'
import Button from '../ui/Button.vue'
import { useSettingsRoute } from '../settings/useSettingsRoute'
import { useExecutorUpgrades } from '../settings/executors/executorUpgrades'
import { versionFailureButtons, versionFailureLine } from './versionFailure'

const props = withDefaults(
  defineProps<{
    context: VersionFailureContext
    variant?: 'row' | 'banner'
  }>(),
  { variant: 'row' },
)

const upgrades = useExecutorUpgrades()
const settings = useSettingsRoute()
const line = computed(() => versionFailureLine(props.context))
const buttons = computed(() =>
  versionFailureButtons(props.context, upgrades.runOf(props.context.profileId)),
)

// Whether a rollback or an upgrade of it is already going.
onMounted(() => {
  if (
    props.context.actions.includes('rollback') ||
    props.context.actions.includes('install_verified')
  )
    void upgrades.load()
})

function executorPage() {
  return settings.openSettings('executors', props.context.backend)
}

function act(action: VersionFailureContext['actions'][number]) {
  const { profileId } = props.context
  if (action === 'rollback') upgrades.askRollback(profileId)
  else if (action === 'install_verified') upgrades.ask([profileId])
  else if (action === 'recheck') {
    void upgrades.selfCheck(profileId)
    return
  }
  void executorPage()
}
</script>

<template>
  <div class="version-failure" :data-variant="variant" data-version-failure>
    <p class="reason" data-version-failure-reason>{{ line }}</p>
    <div class="buttons">
      <Button
        v-for="button in buttons"
        :key="button.action"
        size="sm"
        :variant="button.variant"
        :disabled="button.disabled"
        :data-version-failure-action="button.action"
        @click.stop.prevent="act(button.action)"
        >{{ button.label }}</Button
      >
    </div>
  </div>
</template>

<style scoped>
.version-failure {
  position: relative;
  z-index: var(--z-raised);
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
}

.reason {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  color: rgb(var(--text-2));
  overflow-wrap: anywhere;
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}
</style>
