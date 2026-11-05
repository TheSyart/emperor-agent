<script setup lang="ts">
/**
 * Settings › 群聊: only the default loop guard remains. Every group
 * collaborates autonomously; there is no collaboration, project or Git
 * choice. A failed save says so and restores the previous value.
 */
import { onMounted, ref } from 'vue'
import { core } from '../../api/http'
import { useAppContext } from '../../composables/useAppContext'
import { SettingsGroup, SettingsRow, SettingsSection, Switch } from './ui'

interface Defaults {
  loopGuard: boolean
}

const ctx = useAppContext()
const defaults = ref<Defaults>({ loopGuard: true })

onMounted(async () => {
  try {
    defaults.value = await core('groups.defaults')
  } catch (error) {
    ctx.showError(error, '群聊的默认设置没有读到')
  }
})

async function save(change: Partial<Defaults>): Promise<void> {
  const before = defaults.value
  defaults.value = { ...before, ...change }
  try {
    defaults.value = await core('groups.setDefaults', change)
  } catch (error) {
    defaults.value = before
    ctx.showError(error, '没有保存')
  }
}
</script>

<template>
  <SettingsSection>
    <SettingsGroup
      title="新群的默认设置"
      description="所有群都由成员按职责自主协作；这里只设置防打转默认值"
    >
      <SettingsRow
        title="防打转"
        description="两位成员来回、没有新内容时，内置协调会换人或收尾。按有没有新内容判断，不是额度，不限次数"
        data-default="loopGuard"
      >
        <Switch
          :model-value="defaults.loopGuard"
          aria-label="防打转"
          @update:model-value="save({ loopGuard: $event })"
        />
      </SettingsRow>
    </SettingsGroup>
  </SettingsSection>
</template>
