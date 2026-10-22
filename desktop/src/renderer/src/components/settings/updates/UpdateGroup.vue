<script setup lang="ts">
/**
 * UpdateGroup — 设置 › 常规 › 更新 (REL-02):
 * - 检查更新: the switch (settings.json `updates.check`, default on). Off:
 *   Emperor makes no request for updates at all;
 * - 当前版本: what the last check found (or why there is none) and 立即检查;
 * - a test feed (EMPEROR_UPDATE_FEED_URL) in effect: said here and in 诊断.
 * The prompt for a newer version sits at the top of the page (UpdateNotice).
 */
import { computed, onMounted } from 'vue'
import Button from '../../ui/Button.vue'
import { Notice, SettingsGroup, SettingsRow, Switch } from '../ui'
import { updateStatusText } from './updateModel'
import { useUpdateStatus } from './useUpdateStatus'

const updates = useUpdateStatus()
const status = updates.status
const busy = updates.busy

const usable = computed(() => Boolean(status.value?.automatic))
const enabled = computed(() => Boolean(status.value?.enabled))
const line = computed(() =>
  status.value ? updateStatusText(status.value) : '正在读取…',
)

onMounted(() => void updates.load())
</script>

<template>
  <SettingsGroup title="更新" data-group="updates">
    <SettingsRow title="检查更新" label-for="general-update-check">
      <template #description>
        启动 30 秒后和之后每 24 小时查看 GitHub
        上有没有新版本；只请求版本列表，不发送账号或设备信息
      </template>
      <Switch
        id="general-update-check"
        :model-value="enabled"
        :disabled="!usable || busy === 'switch'"
        @update:model-value="(on: boolean) => updates.setEnabled(on)"
      />
    </SettingsRow>
    <SettingsRow
      :title="`当前版本 ${status?.currentVersion ?? ''}`"
      data-update-line
    >
      <template #description>
        <span>{{ line }}</span>
        <span v-if="updates.error.value" class="error-text" role="alert">{{
          updates.error.value
        }}</span>
      </template>
      <Button
        v-if="usable && enabled"
        size="sm"
        variant="secondary"
        :loading="busy === 'check' || Boolean(status?.checking)"
        data-update-check
        @click="updates.check()"
        >立即检查</Button
      >
    </SettingsRow>
    <Notice
      v-if="status?.feedOverride"
      tone="attention"
      title="正在使用测试更新源"
      data-update-test-feed
    >
      <code>{{ status.feedOverride }}</code>
      （由环境变量 EMPEROR_UPDATE_FEED_URL
      指定，只用于测试；从这里下载的安装包不核验 GitHub 来源证明）
    </Notice>
  </SettingsGroup>
</template>

<style scoped>
.error-text {
  display: block;
  color: rgb(var(--state-error-label));
  overflow-wrap: anywhere;
}
</style>
