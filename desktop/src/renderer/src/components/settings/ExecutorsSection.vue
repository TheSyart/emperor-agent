<script setup lang="ts">
/**
 * 设置 › 子智能体 (AGT-10): the conclusion first, details on demand.
 *
 * - The main page: one card with the three subagents (本地, Claude Code,
 *   Codex — status, model, on/off; a missing sign-in fills the row with its
 *   reason and 设置令牌) and one card with the three task settings (同时运行,
 *   改代码的位置, 费用上限), then 高级.
 * - Sub pages: 高级 (turns, run time, 开发环境, 排查) and each external
 *   subagent's 详情 (status, sign-in, model, specialties, capabilities in
 *   plain words).
 *
 * Every change is saved at once (executors/useExecutorSettings.ts); the
 * header keeps only 重新检测.
 */
import { computed, defineAsyncComponent } from 'vue'
import type { ExecutorProfile } from '@emperor/core/runtime-contract'
import Avatar from '../ui/Avatar.vue'
import Badge from '../ui/Badge.vue'
import Button from '../ui/Button.vue'
import IconButton from '../ui/IconButton.vue'
import SubagentAvatarPreview from '../ui/SubagentAvatarPreview.vue'
import { DsChevronRight } from '../icons/ds'
import {
  Notice,
  Select,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  Switch,
  useSettingsHeader,
} from './ui'
import { useSettingsPages } from './settingsHeader'
import ExecutorAdvancedPage from './executors/ExecutorAdvancedPage.vue'
import ExecutorDetailPage from './executors/ExecutorDetailPage.vue'
import {
  executorName,
  hasIssue,
  rowSummary,
  signInAlert,
  statusLabel,
  statusTone,
} from './executors/executorText'
import { provideExecutorSettings } from './executors/useExecutorSettings'

// 设置令牌 (AGT-02) loads when it is opened.
const ClaudeTokenDialog = defineAsyncComponent(
  () => import('./ClaudeTokenDialog.vue'),
)

const s = provideExecutorSettings()
const { config, rows, models, busy, loading, tokenDialog } = s
const { page, open: openPage } = useSettingsPages({
  advanced: '高级',
  'claude-code': 'Claude Code',
  codex: 'Codex',
})

const detailBackend = computed(() =>
  page.value === 'claude-code' || page.value === 'codex' ? page.value : null,
)

// ── 本地子智能体 ────────────────────────────────────────────────────────

const localModel = computed(() => config.value?.localSubagentModel ?? '')
const localModelOptions = computed(() => {
  const options = [
    { value: '', label: '跟随对话', description: '使用当前对话的模型' },
    ...models.value.map((choice) => ({ ...choice })),
  ]
  if (
    localModel.value &&
    !models.value.some((choice) => choice.value === localModel.value)
  )
    options.push({
      value: localModel.value,
      label: `${localModel.value}（已删除）`,
      description: '这条模型配置已删除，暂时按对话的模型运行',
    })
  return options
})
const localSummary = computed(() => {
  if (!localModel.value) return '使用当前对话的模型，始终可用'
  const choice = models.value.find((c) => c.value === localModel.value)
  return choice
    ? `使用「${choice.label}」，始终可用`
    : '选定的模型已删除，暂时使用当前对话的模型'
})
function setLocalModel(value: string | null | undefined) {
  void s.change((draft) => {
    if (value) draft.localSubagentModel = value
    else delete draft.localSubagentModel
  })
}

// ── Claude Code / Codex ────────────────────────────────────────────────

function needsToken(profile: ExecutorProfile | undefined) {
  if (!profile?.enabled) return false
  const alert = signInAlert(profile, s.factsOf(profile))
  return alert === 'missing' || alert === 'expired' || alert === 'unreadable'
}
function showsModel(profile: ExecutorProfile | undefined) {
  return (
    !!profile?.enabled && !needsToken(profile) && !hasIssue(s.factsOf(profile))
  )
}
function setEnabled(profile: ExecutorProfile, on: boolean) {
  void s.changeProfile(profile.id, (p) => {
    p.enabled = on
  })
}
function setModel(profile: ExecutorProfile, id: string | null | undefined) {
  void s.changeProfile(profile.id, (p) => {
    if (id) p.defaultModel = id
    else delete p.defaultModel
  })
}

// ── 子任务 ────────────────────────────────────────────────────────────

const concurrencyOptions = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: `${n} 个`,
}))
const workspace = computed(
  () => config.value?.defaultWorkspace ?? 'isolated-worktree',
)
const workspaceOptions = [
  {
    value: 'isolated-worktree',
    label: '独立工作树',
    description: '验证后再合并回项目',
  },
  {
    value: 'shared-exclusive',
    label: '当前工作区',
    description: '直接改项目，期间主会话不能同时改',
  },
]
const workspaceDescription = computed(() =>
  workspace.value === 'shared-exclusive'
    ? 'Claude Code、Codex 直接改当前工作区；改完之前，主会话不能同时修改文件'
    : 'Claude Code、Codex 在独立的 Git 工作树里改，验证后再合并回来',
)
const budgetOptions = computed(() => {
  const current = config.value?.limits.estimatedBudgetUsd ?? 10
  return [...new Set([1, 2, 5, 10, current])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `$${n}` }))
})
function setConcurrency(value: string | null | undefined) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 4) return
  void s.change((draft) => {
    draft.limits.globalConcurrency = n
  })
}
function setWorkspace(value: string | null | undefined) {
  void s.change((draft) => {
    if (value === 'shared-exclusive') draft.defaultWorkspace = value
    else delete draft.defaultWorkspace
  })
}
function setBudget(value: string | null | undefined) {
  const n = Number(value)
  if (!(n > 0 && n <= 10)) return
  void s.change((draft) => {
    draft.limits.estimatedBudgetUsd = n
  })
}

/** Acknowledge the upgrade notice: any save clears it (AGT-05). */
function dismissNotice() {
  void s.change((draft) => {
    delete draft.upgradeNotice
  })
}

useSettingsHeader({
  actions: () => [
    {
      id: 'detect-executors',
      label: loading.value ? '检测中…' : '重新检测',
      onClick: () => s.load(true),
      disabled: busy.value,
      busy: loading.value,
    },
  ],
})
</script>

<template>
  <SettingsSection
    v-if="page === null"
    intro="Emperor 可以把子任务交给本地子智能体，或交给你电脑上已登录的 Claude Code、Codex。主任务、权限和验证始终由 Emperor 负责。"
  >
    <Notice
      v-if="s.error.value"
      tone="error"
      :title="s.error.value"
      data-executor-error
    />
    <p v-if="loading && !config" class="executor-note" role="status">
      正在读取子智能体配置…
    </p>
    <Notice
      v-if="config?.upgradeNotice === 'external-default-off'"
      tone="info"
      title="Claude Code 和 Codex 现在默认关闭"
      data-executor-upgrade-notice
    >
      它们会使用你自己的订阅额度或 API
      计费。升级前它们按旧版默认开启，你没有改过这项设置，所以已关闭；需要时在下面打开，第一次把任务交给它们前会在对话里征得你的同意。
      <template #actions>
        <Button
          size="sm"
          variant="secondary"
          data-dismiss-upgrade-notice
          :disabled="busy"
          @click="dismissNotice"
          >知道了</Button
        >
      </template>
    </Notice>

    <SettingsGroup title="可用的子智能体" data-executor-list>
      <SettingsRow
        title="本地子智能体"
        :description="localSummary"
        data-settings-agent="local"
      >
        <template #leading><SubagentAvatarPreview :size="28" /></template>
        <Select
          :model-value="localModel"
          :options="localModelOptions"
          size="sm"
          data-local-model
          aria-label="本地子智能体使用的模型"
          :disabled="!config || busy"
          @update:model-value="setLocalModel"
        />
      </SettingsRow>
      <SettingsRow
        v-for="row in rows"
        :key="row.backend"
        :title="executorName(row.backend)"
        :data-settings-agent="row.backend"
        :data-needs-token="needsToken(row.profile) || undefined"
      >
        <template #leading
          ><Avatar
            kind="logo"
            :icon-id="row.backend"
            :label="executorName(row.backend)"
            :size="28"
        /></template>
        <template #badge
          ><Badge
            class="readiness"
            :tone="
              row.profile
                ? statusTone(row.profile, s.factsOf(row.profile))
                : 'neutral'
            "
            >{{
              row.profile
                ? statusLabel(row.profile, s.factsOf(row.profile))
                : loading
                  ? '读取中…'
                  : '未配置'
            }}</Badge
          ></template
        >
        <template #description
          ><span data-executor-summary>{{
            row.profile
              ? rowSummary(row.profile, s.factsOf(row.profile))
              : '没有这个子智能体的配置'
          }}</span></template
        >
        <div class="row-controls">
          <Button
            v-if="needsToken(row.profile)"
            size="sm"
            variant="secondary"
            data-claude-token-set
            :disabled="busy || s.tokenBusy.value"
            @click="tokenDialog = row.profile ?? null"
            >设置令牌</Button
          >
          <Select
            v-else-if="row.profile && showsModel(row.profile)"
            :model-value="row.profile.defaultModel ?? ''"
            :options="s.modelOptionsOf(row.profile)"
            size="sm"
            data-row-model
            :aria-label="`${executorName(row.backend)} 默认模型`"
            :disabled="busy"
            @update:model-value="setModel(row.profile, $event)"
          />
          <Switch
            v-if="row.profile"
            :model-value="row.profile.enabled"
            data-executor-enabled
            :aria-label="`启用 ${executorName(row.backend)}`"
            :disabled="busy"
            @update:model-value="setEnabled(row.profile, $event)"
          />
          <IconButton
            :label="`${executorName(row.backend)} 详情`"
            size="sm"
            data-executor-details
            @click="openPage(row.backend)"
            ><DsChevronRight :size="16"
          /></IconButton>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup v-if="config" title="子任务" data-executor-task-settings>
      <SettingsRow
        title="同时运行"
        description="Claude Code 和 Codex 合计；超过后排队等候"
      >
        <Select
          :model-value="String(config.limits.globalConcurrency)"
          :options="concurrencyOptions"
          size="sm"
          data-global-concurrency
          aria-label="同时运行的子任务数"
          :disabled="busy"
          @update:model-value="setConcurrency"
        />
      </SettingsRow>
      <SettingsRow title="改代码的位置" :description="workspaceDescription">
        <Select
          :model-value="workspace"
          :options="workspaceOptions"
          size="sm"
          data-default-workspace
          aria-label="改代码的位置"
          :disabled="busy"
          @update:model-value="setWorkspace"
        />
      </SettingsRow>
      <SettingsRow
        title="单个任务的费用上限"
        description="按 API 计费时的估算费用；订阅额度不计费用"
      >
        <Select
          :model-value="String(config.limits.estimatedBudgetUsd)"
          :options="budgetOptions"
          size="sm"
          data-task-budget
          aria-label="单个任务的费用上限"
          :disabled="busy"
          @update:model-value="setBudget"
        />
      </SettingsRow>
      <SettingsLinkRow
        title="高级"
        description="最多轮数、运行时长、开发环境与排查"
        data-executor-advanced-link
        @click="openPage('advanced')"
      />
    </SettingsGroup>
  </SettingsSection>
  <ExecutorAdvancedPage v-else-if="page === 'advanced'" />
  <ExecutorDetailPage v-else-if="detailBackend" :backend="detailBackend" />
  <ClaudeTokenDialog
    v-if="tokenDialog"
    :profile-id="tokenDialog.id"
    :kind="
      s.factsOf(tokenDialog).probe?.auth?.kind === 'api-key'
        ? 'api-key'
        : 'oauth-token'
    "
    @close="tokenDialog = null"
    @saved="
      (probe) => {
        if (tokenDialog) s.tokenSaved(tokenDialog, probe)
        tokenDialog = null
      }
    "
  />
</template>

<style scoped>
.executor-note {
  margin: 0;
  font-size: var(--fs-xs);
  color: rgb(var(--text-3));
}
.row-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.readiness {
  font-size: var(--fs-xxxs);
}
</style>
