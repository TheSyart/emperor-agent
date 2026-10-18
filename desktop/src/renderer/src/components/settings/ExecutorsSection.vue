<script setup lang="ts">
/** Minimal source controls. Hidden settings are round-tripped without edits. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ExecutorConfig,
  ExecutorProfile,
  ExecutorProbe,
  ExecutorRuntimeFacts,
  NativeCapabilityStatus,
  NativeCapabilityEvidence,
} from '@emperor/core/runtime-contract'
import { executorSpecialties } from '@emperor/core/runtime-contract'
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
  runtimes = ref<Record<string, ExecutorRuntimeFacts | undefined>>({}),
  editingSpecialties = ref<Record<string, boolean>>({}),
  specialtyText = ref<Record<string, string>>({}),
  specialtyErrors = ref<Record<string, string>>({}),
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
const invalidSpecialties = computed(() =>
  Object.values(specialtyErrors.value).some(Boolean),
)
const capabilityLabels: Record<NativeCapabilityStatus, string> = {
  unverified: '未验证',
  verifying: '验证中',
  available: '已验证可用',
  unavailable: '不可用',
  unsupported: '当前接入不支持',
  stale: '验证已失效',
}
function editSpecialties(profile: ExecutorProfile) {
  editingSpecialties.value[profile.id] = !editingSpecialties.value[profile.id]
  specialtyText.value[profile.id] = executorSpecialties(profile).join('，')
}
function updateSpecialties(profile: ExecutorProfile, text: string) {
  specialtyText.value[profile.id] = text
  const items = text
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  specialtyErrors.value[profile.id] =
    items.length > 6
      ? '最多 6 项专长'
      : items.some((s) => [...s].length > 24)
        ? '每项最多 24 字'
        : ''
  profile.specialties = items
}
function resetSpecialties(profile: ExecutorProfile) {
  delete profile.specialties
  specialtyText.value[profile.id] = executorSpecialties(profile).join('，')
  delete specialtyErrors.value[profile.id]
}
function capability(
  profile: ExecutorProfile,
  kind: 'search' | 'imageGeneration',
): NativeCapabilityEvidence {
  return (
    runtimes.value[profile.id]?.nativeCapabilities[kind] ?? {
      status:
        profile.backend === 'claude-code' && kind === 'imageGeneration'
          ? ('unsupported' as const)
          : ('unverified' as const),
    }
  )
}
function capabilityDetail(
  profile: ExecutorProfile,
  kind: 'search' | 'imageGeneration',
) {
  const fact = capability(profile, kind)
  return [
    fact.checkedAt ? new Date(fact.checkedAt).toLocaleString() : null,
    fact.searchMode === 'live'
      ? '实时搜索'
      : fact.searchMode === 'cached'
        ? '缓存搜索'
        : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
function label(profile: ExecutorProfile) {
  if (loading.value) return '检测中…'
  if (probeErrors.value[profile.id]) return '检测失败'
  const probe = probes.value[profile.id]
  if (!probe) return '未检测'
  if (probe.diagnostic === 'executor version probe failed') return '检测失败'
  if (probe.diagnostic === 'AUTH_REQUIRED') return '需要登录配置'
  if (probe.diagnostic === 'AUTH_ROUTE_UNAVAILABLE') return '凭据不可用'
  return {
    available: '执行器就绪',
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
    editingSpecialties.value = {}
    specialtyErrors.value = {}
    specialtyText.value = {}
    runtimes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.runtime]),
    )
    saved.value = JSON.stringify(config.value)
    stale.value = false
    probes.value = Object.fromEntries(
      result.profiles.map((entry) => [entry.profile.id, entry.probe]),
    )
    probeErrors.value = {}
    if (result.diagnostic)
      error.value = `${result.diagnostic}；请检查原配置后重新检测。`
    let didProbe = false
    await Promise.all(
      result.profiles
        .filter((entry) => forceProbe || !entry.probe?.localAuthChecked)
        .map(async (entry) => {
          const profile = config.value?.profiles.find(
            (profile) => profile.id === entry.profile.id,
          )
          if (!profile) return
          const key = JSON.stringify(profile)
          try {
            didProbe = true
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
    if (didProbe && current === generation) {
      const refreshed = await listExecutors()
      if (current === generation)
        runtimes.value = Object.fromEntries(
          refreshed.profiles.map((entry) => [entry.profile.id, entry.runtime]),
        )
    }
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
    invalidSpecialties.value ||
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
      disabled:
        busy.value ||
        loading.value ||
        !dirty.value ||
        stale.value ||
        invalidSpecialties.value,
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
              }}{{
                probes[row.profile.id]?.status === 'available' &&
                probes[row.profile.id]?.localAuthChecked
                  ? '可读'
                  : ''
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
        <div v-if="row.profile" class="source-help source-facts">
          <p data-specialties>
            {{ executorSpecialties(row.profile).join(' · ') || '未设置专长' }}
          </p>
          <p :title="runtimes[row.profile.id]?.modelSource ?? ''">
            运行时报告模型：{{
              runtimes[row.profile.id]?.reportedModel ?? '未知'
            }}<span v-if="runtimes[row.profile.id]?.provider">
              · {{ runtimes[row.profile.id]?.provider }}</span
            >
          </p>
          <p class="capability-line">
            <span
              v-for="kind in ['search', 'imageGeneration'] as const"
              :key="kind"
              :data-native-capability="kind"
              :data-status="capability(row.profile, kind).status"
              :title="capabilityDetail(row.profile, kind)"
              >{{ kind === 'search' ? '搜索' : '生图' }}：{{
                capabilityLabels[capability(row.profile, kind).status]
              }}</span
            >
          </p>
          <div class="recovery-actions">
            <Button
              size="sm"
              variant="ghost"
              data-edit-specialties
              :disabled="busy || loading"
              @click="editSpecialties(row.profile)"
              >{{
                editingSpecialties[row.profile.id] ? '收起编辑' : '编辑专长'
              }}</Button
            >
            <Button
              v-if="editingSpecialties[row.profile.id]"
              size="sm"
              variant="ghost"
              data-reset-specialties
              :disabled="busy || loading"
              @click="resetSpecialties(row.profile)"
              >恢复默认</Button
            >
          </div>
          <template v-if="editingSpecialties[row.profile.id]">
            <TextField
              :model-value="specialtyText[row.profile.id]"
              data-specialty-input
              :aria-label="`${row.name} 专长`"
              :invalid="!!specialtyErrors[row.profile.id]"
              :disabled="busy || loading"
              placeholder="逗号分隔，最多 6 项，每项 24 字"
              @update:model-value="updateSpecialties(row.profile, $event)"
            />
            <p
              v-if="specialtyErrors[row.profile.id]"
              class="executor-error"
              role="alert"
            >
              {{ specialtyErrors[row.profile.id] }}
            </p>
          </template>
          <details v-if="runtimes[row.profile.id]" class="capability-details">
            <summary>能力详情</summary>
            <p>
              配置模型：{{
                runtimes[row.profile.id]?.configuredModel ??
                row.profile.defaultModel ??
                'CLI 默认，尚未确认'
              }}
            </p>
            <p>
              宿主开放：{{
                runtimes[row.profile.id]?.hostAllowedTools.join('、')
              }}
            </p>
            <p>
              运行时公布：{{
                runtimes[row.profile.id]?.advertisedTools?.join('、') || '未知'
              }}
            </p>
            <p>
              实际调用：{{
                runtimes[row.profile.id]?.observedTools.join('、') ||
                '尚未观察到'
              }}
            </p>
            <p>
              搜索：{{
                capabilityDetail(row.profile, 'search') || '尚无验证记录'
              }}
            </p>
            <p>
              生图：{{
                capabilityDetail(row.profile, 'imageGeneration') ||
                '尚无验证记录'
              }}
            </p>
          </details>
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
.source-facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.capability-line {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.capability-line [data-status='available'] {
  color: rgb(var(--state-ok-label));
}
.capability-details summary {
  cursor: pointer;
}
.capability-details p {
  margin-top: var(--space-1);
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
