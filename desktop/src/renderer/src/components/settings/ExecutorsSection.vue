<script setup lang="ts">
/** External CLIs are opt-in profiles. Secrets stay in the host credential resolver. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ExecutorConfig,
  ExecutorProfile,
  ExecutorProbe,
} from '@emperor/core/runtime-contract'
import {
  listExecutors,
  configureExecutors,
  probeExecutor,
} from '../../api/delegations'
import {
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  TextField,
  Select,
  Switch,
  StatusBadge,
  useSettingsHeader,
  refreshAction,
} from './ui'
import Button from '../ui/Button.vue'
const config = ref<ExecutorConfig | null>(null),
  probes = ref<Record<string, ExecutorProbe | null>>({}),
  loading = ref(false),
  busy = ref(false),
  error = ref('')
let generation = 0
const saved = ref('')
const dirty = computed(
  () => config.value !== null && JSON.stringify(config.value) !== saved.value,
)
const labels: Record<ExecutorProbe['status'], string> = {
  available: '可用',
  missing: '未找到',
  needs_auth: '需要认证',
  incompatible: '版本不兼容',
  containment_unavailable: '隔离不可用',
}
function probeLabel(profile: ExecutorProfile) {
  return probes.value[profile.id]
    ? labels[probes.value[profile.id]!.status]
    : '未检测'
}
async function load() {
  const current = ++generation
  loading.value = true
  try {
    const result = await listExecutors()
    if (current !== generation) return
    config.value = result.config
      ? (JSON.parse(JSON.stringify(result.config)) as ExecutorConfig)
      : null
    saved.value = JSON.stringify(config.value)
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    if (result.diagnostic) error.value = result.diagnostic
  } catch (cause) {
    if (current === generation) error.value = String(cause)
  } finally {
    if (current === generation) loading.value = false
  }
}
async function save() {
  if (busy.value || !config.value) return
  busy.value = true
  error.value = ''
  try {
    await configureExecutors({
      expectedRevision: config.value.revision,
      config: JSON.parse(JSON.stringify(config.value)) as ExecutorConfig,
    })
    await load()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    await load()
  } finally {
    busy.value = false
  }
}
async function detect(profile: ExecutorProfile) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    probes.value[profile.id] = await probeExecutor({ profileId: profile.id })
  } catch (cause) {
    error.value = String(cause)
  } finally {
    busy.value = false
  }
}
function auth(
  profile: ExecutorProfile,
  kind: 'managed-cli-login' | 'model-route',
) {
  profile.authRef =
    kind === 'managed-cli-login' ? { kind } : { kind, routeId: '' }
}
function number(value: string, max: number) {
  const n = Number(value)
  return Math.max(1, Math.min(max, Number.isFinite(n) ? Math.floor(n) : 1))
}
useSettingsHeader({
  actions: () => [
    refreshAction(load, { label: '刷新执行器配置' }),
    {
      id: 'save-executors',
      label: '保存配置',
      kind: 'primary',
      onClick: save,
      disabled: busy.value || loading.value || !dirty.value,
      busy: busy.value,
    },
  ],
})
onMounted(() => void load())
onBeforeUnmount(() => {
  generation++
})
</script>
<template>
  <SettingsSection
    intro="让 Claude Code 和 Codex 作为外部子代理执行任务。启用后仍由主代理选择调度；默认使用内部子代理。"
  >
    <p v-if="error" class="executor-error" role="alert">{{ error }}</p>
    <p v-if="loading && !config" class="executor-note">正在读取执行器配置…</p>
    <template v-if="config">
      <SettingsGroup
        v-for="profile in config.profiles"
        :key="profile.id"
        :title="`${profile.backend === 'codex' ? 'Codex' : 'Claude Code'} · ${profile.id}`"
      >
        <template #actions
          ><StatusBadge
            :tone="probes[profile.id]?.status === 'available' ? 'ok' : 'warn'"
            >{{ probeLabel(profile) }}</StatusBadge
          ><StatusBadge v-if="!profile.enabled">已关闭</StatusBadge></template
        >
        <SettingsRow
          title="启用执行器"
          :description="`协议基线 ${profile.expectedVersion}`"
          ><Switch
            v-model="profile.enabled"
            data-executor-enabled
            :disabled="busy"
            :aria-label="`启用 ${profile.id}`"
        /></SettingsRow>
        <SettingsRow
          title="可执行文件"
          layout="stacked"
          :label-for="`executor-path-${profile.id}`"
          ><TextField
            :id="`executor-path-${profile.id}`"
            v-model="profile.executablePath"
            monospace
            :disabled="busy"
            autocomplete="off"
        /></SettingsRow>
        <SettingsRow
          title="默认模型"
          layout="stacked"
          :label-for="`executor-model-${profile.id}`"
          ><TextField
            :id="`executor-model-${profile.id}`"
            :model-value="profile.defaultModel ?? ''"
            placeholder="留空使用执行器默认模型"
            :disabled="busy"
            @update:model-value="profile.defaultModel = $event || undefined"
        /></SettingsRow>
        <SettingsRow
          title="认证方式"
          description="使用本机已配置的 CLI 登录，或引用模型设置中的凭据。这里不接收密钥。"
          ><Select
            :model-value="profile.authRef.kind"
            :options="[
              { value: 'managed-cli-login', label: '本机 CLI 登录' },
              { value: 'model-route', label: '模型凭据引用' },
            ]"
            :disabled="busy"
            @change="auth(profile, $event)"
        /></SettingsRow>
        <SettingsRow
          v-if="profile.authRef.kind === 'model-route'"
          title="模型条目 ID"
          layout="stacked"
          :label-for="`executor-route-${profile.id}`"
          ><TextField
            :id="`executor-route-${profile.id}`"
            v-model="profile.authRef.routeId"
            :disabled="busy"
            placeholder="模型设置中的条目 ID"
            monospace
        /></SettingsRow>
        <SettingsRow title="并发上限"
          ><Select
            v-model="profile.concurrencyLimit"
            :options="[
              { value: 1, label: '1 个任务' },
              { value: 2, label: '2 个任务' },
            ]"
            :disabled="busy"
        /></SettingsRow>
        <SettingsRow
          title="检测结果"
          :description="probes[profile.id]?.diagnostic"
          ><template #default
            ><span class="executor-note"
              >{{ probes[profile.id]?.executableVersion ?? '尚无版本记录' }} ·
              {{
                probes[profile.id]?.authVerified
                  ? '认证已验证'
                  : '本次检测未校验服务端认证'
              }}</span
            ><Button
              size="sm"
              variant="outline"
              :disabled="busy || loading || dirty"
              @click="detect(profile)"
              >检测</Button
            ></template
          ></SettingsRow
        >
      </SettingsGroup>
      <SettingsGroup title="调度配额">
        <SettingsRow title="全局并发"
          ><Select
            v-model="config.limits.globalConcurrency"
            :options="[
              { value: 1, label: '1 个任务' },
              { value: 2, label: '2 个任务' },
            ]"
            :disabled="busy"
        /></SettingsRow>
        <SettingsRow title="每个任务最多执行轮数"
          ><TextField
            type="number"
            :model-value="String(config.limits.maxRunsPerTask)"
            :disabled="busy"
            aria-label="每任务最多轮数"
            @update:model-value="
              config.limits.maxRunsPerTask = number($event, 32)
            "
        /></SettingsRow>
      </SettingsGroup>
      <p class="executor-note">
        使用顶部“保存配置”提交修改，再检测执行器。检测不会提交模型任务。
      </p>
    </template>
  </SettingsSection>
</template>
<style scoped>
.executor-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
}
.executor-note {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.executor-error {
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
</style>
