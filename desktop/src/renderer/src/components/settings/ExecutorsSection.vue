<script setup lang="ts">
/** Minimal source controls. Hidden settings are round-tripped without edits. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ExecutorConfig,
  ExecutorProfile,
  ExecutorProbe,
} from '@emperor/core/runtime-contract'
import { openExternal } from '../../api/backend'
import {
  listExecutors,
  configureExecutors,
  probeExecutor,
} from '../../api/delegations'
import {
  SettingsSection,
  TextField,
  Select,
  Switch,
  useSettingsHeader,
} from './ui'
import Button from '../ui/Button.vue'
import ProviderLogo from '../ui/ProviderLogo.vue'
import SubagentAvatarPreview from '../ui/SubagentAvatarPreview.vue'
const config = ref<ExecutorConfig | null>(null),
  probes = ref<Record<string, ExecutorProbe | null>>({}),
  probeErrors = ref<Record<string, string>>({}),
  selected = ref<Record<string, string>>({}),
  recovery = ref<Record<string, boolean>>({}),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  saved = ref(''),
  reloadRequested = ref(false),
  stale = ref(false)
let generation = 0
const dirty = computed(
  () => config.value !== null && JSON.stringify(config.value) !== saved.value,
)
const rows = computed(() =>
  (['claude-code', 'codex'] as const).map((backend) => {
    const profiles =
      config.value?.profiles.filter((profile) => profile.backend === backend) ??
      []
    return {
      backend,
      name: backend === 'codex' ? 'Codex' : 'Claude Code',
      profiles,
      profile:
        profiles.find((profile) => profile.id === selected.value[backend]) ??
        profiles[0],
    }
  }),
)
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
function label(profile: ExecutorProfile) {
  if (loading.value) return '检测中…'
  if (probeErrors.value[profile.id]) return '检测失败'
  const probe = probes.value[profile.id]
  if (!probe) return '未检测'
  if (probe.diagnostic === 'executor version probe failed') return '检测失败'
  if (probe.diagnostic === 'AUTH_REQUIRED') return '需要登录配置'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE') return '凭据不可用'
  return {
    available: '可用',
    missing: '未找到 CLI',
    needs_auth: '需要登录配置',
    incompatible: '版本不兼容',
    containment_unavailable: '运行环境不可用',
  }[probe.status]
}
function detail(profile: ExecutorProfile) {
  if (probeErrors.value[profile.id])
    return `检测失败：${probeErrors.value[profile.id]}`
  const probe = probes.value[profile.id]
  if (!probe) return ''
  if (probe.diagnostic === 'executor version probe failed')
    return 'CLI 版本检测失败，请检查可执行权限及本机运行环境后重试。'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE')
    return '所选模型凭据不可读，请在模型设置检查原配置。'
  if (probe.status === 'needs_auth' || probe.diagnostic === 'AUTH_REQUIRED')
    return profile.authRef.kind === 'model-route'
      ? '所选模型凭据不可读，请在模型设置检查原配置。'
      : `请在终端运行 ${profile.backend === 'codex' ? 'codex login' : 'claude auth login'}。${profile.backend === 'claude-code' ? 'Emperor 需要可读取的 CLI 文件或环境变量认证；仅钥匙串登录不可用。' : ''}配置完成后重新检测。`
  if (probe.status === 'missing')
    return '未找到 CLI，请检查本机安装或更正路径后保存。'
  if (probe.status === 'incompatible')
    return `CLI 版本不兼容：实际 ${probe.executableVersion ?? '未知'}，预期 ${profile.expectedVersion}。请检查本机 CLI 版本。`
  if (probe.status === 'containment_unavailable')
    return '本机运行环境不可用，请检查 CLI 运行环境后重试。'
  return ''
}
function hasIssue(profile: ExecutorProfile) {
  return (
    !!probeErrors.value[profile.id] ||
    (!!probes.value[profile.id] &&
      probes.value[profile.id]!.status !== 'available')
  )
}
async function load(forceProbe = false, discard = false) {
  if (loading.value || busy.value) return
  if (dirty.value && !discard) {
    reloadRequested.value = true
    return
  }
  const current = ++generation
  loading.value = true
  error.value = ''
  reloadRequested.value = false
  try {
    const result = await listExecutors()
    if (current !== generation) return
    config.value = clone(result.config)
    saved.value = JSON.stringify(config.value)
    stale.value = false
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    probeErrors.value = {}
    if (result.diagnostic)
      error.value = `${result.diagnostic}；请检查原配置后重新检测。`
    await Promise.all(
      result.profiles
        .filter((entry) => forceProbe || !entry.probe)
        .map(async (entry) => {
          const profile = config.value?.profiles.find(
            (profile) => profile.id === entry.profile.id,
          )
          if (!profile) return
          const key = JSON.stringify(profile)
          try {
            const probe = await probeExecutor({ profileId: profile.id })
            if (
              current === generation &&
              JSON.stringify(
                config.value?.profiles.find((p) => p.id === profile.id),
              ) === key
            )
              probes.value[profile.id] = probe
          } catch (cause) {
            if (current === generation)
              probeErrors.value[profile.id] = message(cause)
          }
        }),
    )
  } catch (cause) {
    if (current === generation)
      error.value = `读取配置失败：${message(cause)}；请重新检测。`
  } finally {
    if (current === generation) loading.value = false
  }
}
async function installHelp(profile: ExecutorProfile) {
  try {
    await openExternal(
      profile.backend === 'codex'
        ? 'https://learn.chatgpt.com/docs/codex/cli'
        : 'https://code.claude.com/docs/en/setup',
    )
  } catch {
    error.value = '无法打开安装说明，请检查系统浏览器后重试。'
  }
}
async function save() {
  if (
    busy.value ||
    loading.value ||
    !config.value ||
    !dirty.value ||
    stale.value
  )
    return
  const current = ++generation,
    draft = clone(config.value)
  busy.value = true
  error.value = ''
  try {
    const result = await configureExecutors({
      expectedRevision: draft.revision,
      config: draft,
    })
    if (current !== generation) return
    config.value = clone(result)
    saved.value = JSON.stringify(config.value)
    probes.value = {}
    probeErrors.value = {}
    reloadRequested.value = false
  } catch (cause) {
    if (current !== generation) return
    error.value = message(cause)
    if (error.value.includes('STALE_REVISION')) {
      stale.value = true
      reloadRequested.value = true
    }
  } finally {
    if (current === generation) busy.value = false
  }
}
useSettingsHeader({
  actions: () => [
    {
      id: 'detect-executors',
      label: loading.value ? '检测中…' : '重新检测',
      onClick: () => load(true),
      disabled: loading.value || busy.value,
      busy: loading.value,
    },
    {
      id: 'save-executors',
      label: '保存配置',
      kind: 'primary',
      onClick: save,
      disabled: busy.value || loading.value || !dirty.value || stale.value,
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
  <SettingsSection intro="由主会话统一派工。">
    <p v-if="error" class="executor-error" role="alert">{{ error }}</p>
    <p v-if="loading && !config" class="executor-note" role="status">
      正在读取子智能体配置…
    </p>
    <div v-if="reloadRequested" class="reload-notice" role="status">
      <span>有未保存的修改。重新读取会丢弃这些修改。</span>
      <Button
        size="sm"
        variant="outline"
        data-discard-executor-edits
        :disabled="busy || loading"
        @click="load(true, true)"
        >丢弃修改并重新读取</Button
      >
    </div>
    <div class="sources">
      <section class="source" data-settings-agent="local">
        <div class="source-main">
          <SubagentAvatarPreview />
          <div class="source-copy">
            <h3>本地</h3>
            <p>自动分配角色头像</p>
          </div>
          <span class="executor-note">内置</span>
        </div>
      </section>
      <section
        v-for="row in rows"
        :key="row.backend"
        class="source"
        :data-settings-agent="row.backend"
        :data-profile-id="row.profile?.id"
      >
        <div class="source-main">
          <ProviderLogo
            :icon-id="row.backend"
            :label="row.name"
            size="lg"
            :data-agent-logo="row.backend"
          />
          <div class="source-copy">
            <h3>{{ row.name }}</h3>
            <p v-if="row.profile">
              {{
                row.profile.authRef.kind === 'managed-cli-login'
                  ? '本机登录配置'
                  : '模型凭据引用'
              }}{{ probes[row.profile.id]?.status === 'available' ? '可读' : ''
              }}<span> · </span
              ><span :data-probe-status="probes[row.profile.id]?.status">{{
                label(row.profile)
              }}</span>
            </p>
            <p v-else>{{ loading ? '读取中…' : '未配置' }}</p>
          </div>
          <Select
            v-if="row.profiles.length > 1"
            :model-value="row.profile!.id"
            :options="
              row.profiles.map((profile) => ({
                value: profile.id,
                label: profile.id,
              }))
            "
            size="sm"
            data-executor-profile
            :aria-label="`${row.name} 配置`"
            :disabled="busy || loading"
            @change="selected[row.backend] = $event"
          />
          <Switch
            v-if="row.profile"
            v-model="row.profile.enabled"
            data-executor-enabled
            :disabled="busy || loading"
            :aria-label="`启用 ${row.name}`"
          />
        </div>
        <template v-if="row.profile && hasIssue(row.profile)">
          <div class="source-help">
            <p role="status">{{ detail(row.profile) }}</p>
            <div class="recovery-actions">
              <Button
                v-if="probes[row.profile.id]?.status === 'missing'"
                size="sm"
                variant="ghost"
                data-executor-install-help
                @click="installHelp(row.profile)"
                >安装说明</Button
              ><Button
                size="sm"
                variant="ghost"
                :disabled="busy || loading"
                @click="load(true)"
                >重试</Button
              ><Button
                size="sm"
                variant="ghost"
                data-executor-recovery
                :disabled="busy || loading"
                @click="recovery[row.profile.id] = !recovery[row.profile.id]"
                >更正路径</Button
              >
            </div>
            <TextField
              v-if="recovery[row.profile.id]"
              v-model="row.profile.executablePath"
              :aria-label="`${row.name} 可执行文件路径`"
              :disabled="busy || loading"
              autocomplete="off"
              monospace
            />
          </div>
        </template>
      </section>
    </div>
  </SettingsSection>
</template>
<style scoped>
.sources {
  display: flex;
  flex-direction: column;
}
.source {
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border-l2);
}
.source:last-child {
  border-bottom: none;
}
.source-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.source-copy {
  flex: 1;
  min-width: 140px;
}
h3,
p {
  margin: 0;
}
h3 {
  font-size: var(--fs-s);
  line-height: var(--lh-s);
  font-weight: 500;
  color: rgb(var(--label-primary));
}
.source-copy p,
.executor-note,
.source-help,
.reload-notice {
  color: rgb(var(--label-tertiary));
  font-size: var(--fs-xs);
  line-height: var(--lh-xs);
  overflow-wrap: anywhere;
}
.source-help {
  padding-top: var(--space-2);
  padding-left: calc(40px + var(--space-3));
}
.recovery-actions {
  display: flex;
  gap: var(--space-2);
  margin: var(--space-2) 0;
}
.reload-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.executor-error {
  color: rgb(var(--state-error-label));
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}
</style>
