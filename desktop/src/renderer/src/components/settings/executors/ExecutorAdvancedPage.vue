<script setup lang="ts">
/**
 * 设置 › 子智能体 › 高级 (AGT-10): what most people never change — Claude
 * Code's turns per run, how long one run may take, the development
 * environment a task may use (AGT-08), which claude runs, and the switches
 * for tracking problems down (验证后再应用, 诊断模式). Saved at once.
 */
import { computed } from 'vue'
import type { ExecutorConfig } from '@emperor/core/runtime-contract'
import {
  Select,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Switch,
} from '../ui'
import { usesBundledClaude } from './executorText'
import { useExecutorSettings } from './useExecutorSettings'

const s = useExecutorSettings()
const { config, busy } = s

// 每次运行最多轮数: absent means Core's default of 200.
const DEFAULT_MAX_TURNS = 200
const turnOptions = computed(() => {
  const current = config.value?.limits.claudeMaxTurns ?? DEFAULT_MAX_TURNS
  return [...new Set([50, 100, 200, 300, 500, 1000, current])]
    .sort((a, b) => a - b)
    .map((n) => ({
      value: String(n),
      label: n === DEFAULT_MAX_TURNS ? `${n} 轮（默认）` : `${n} 轮`,
    }))
})
function setMaxTurns(value: string | null | undefined) {
  const turns = Number(value)
  if (!Number.isInteger(turns)) return
  void s.change((draft) => {
    if (turns === DEFAULT_MAX_TURNS) delete draft.limits.claudeMaxTurns
    else draft.limits.claudeMaxTurns = turns
  })
}

// 单次运行时长上限: Core allows up to 120 minutes.
const timeoutOptions = computed(() => {
  const current = Math.round((config.value?.limits.runTimeoutMs ?? 0) / 60_000)
  return [...new Set([10, 30, 60, 120, ...(current > 0 ? [current] : [])])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: `${n} 分钟` }))
})
function setRunTimeout(value: string | null | undefined) {
  const minutes = Number(value)
  if (!(minutes >= 1 && minutes <= 120)) return
  void s.change((draft) => {
    draft.limits.runTimeoutMs = minutes * 60_000
  })
}

// 开发环境 (AGT-08): what a task's environment passes through.
type DevEnvKey = keyof NonNullable<ExecutorConfig['developmentEnvironment']>
const DEV_ENV_DEFAULTS: Record<DevEnvKey, boolean> = {
  gitIdentity: true,
  proxy: true,
  sshAgent: false,
  toolchains: false,
  github: false,
}
const DEV_ENV_ROWS: ReadonlyArray<{
  key: DevEnvKey
  title: string
  description: string
}> = [
  {
    key: 'gitIdentity',
    title: 'Git 身份',
    description: '子智能体提交时使用你 git 配置里的姓名和邮箱。',
  },
  {
    key: 'proxy',
    title: '网络代理',
    description: '沿用 Emperor 的 HTTP(S)_PROXY 与 NO_PROXY。',
  },
  {
    key: 'sshAgent',
    title: 'SSH 代理',
    description:
      '子智能体可以用你的 SSH 密钥访问远端仓库（经 SSH agent，不复制密钥）。',
  },
  {
    key: 'toolchains',
    title: '开发工具链',
    description:
      'nvm、volta、rustup / cargo、pyenv 安装的 node、rust、python 可用。',
  },
  {
    key: 'github',
    title: '允许子智能体使用 GitHub 登录',
    description:
      '把 gh 当前登录的令牌交给子任务（GH_TOKEN），子智能体可以用 gh 读写你的仓库。',
  },
]
function devEnv(key: DevEnvKey): boolean {
  return (config.value?.developmentEnvironment ?? DEV_ENV_DEFAULTS)[key]
}
function setDevEnv(key: DevEnvKey, on: boolean) {
  void s.change((draft) => {
    const next = {
      ...(draft.developmentEnvironment ?? DEV_ENV_DEFAULTS),
      [key]: on,
    }
    // Stored only when it differs from the defaults.
    if (
      (Object.keys(next) as DevEnvKey[]).every(
        (k) => next[k] === DEV_ENV_DEFAULTS[k],
      )
    )
      delete draft.developmentEnvironment
    else draft.developmentEnvironment = next
  })
}

const claude = computed(() => s.rowOf('claude-code').profile)
const claudeFacts = computed(() =>
  claude.value ? s.factsOf(claude.value) : {},
)
function setInstalledClaude(installed: boolean) {
  const profile = claude.value
  if (!profile) return
  void s.changeProfile(profile.id, (p) => {
    p.executableSource = installed ? 'system' : 'bundled'
  })
}

function setVerifyFirst(on: boolean) {
  void s.change((draft) => {
    if (on) draft.verifyBeforeApply = true
    else delete draft.verifyBeforeApply
  })
}
function setDiagnostics(on: boolean) {
  void s.change((draft) => {
    if (on) draft.diagnosticsMode = true
    else delete draft.diagnosticsMode
  })
}
</script>

<template>
  <SettingsSection data-executor-advanced>
    <template v-if="config">
      <SettingsGroup title="运行">
        <SettingsRow
          title="每次运行最多轮数"
          description="Claude Code 一次运行里最多调用模型的轮数。用完时这次运行以「达到最多轮数」结束，主会话可以发消息让它继续。"
        >
          <Select
            :model-value="
              String(config.limits.claudeMaxTurns ?? DEFAULT_MAX_TURNS)
            "
            :options="turnOptions"
            size="sm"
            data-claude-max-turns
            aria-label="Claude Code 每次运行最多轮数"
            :disabled="busy"
            @update:model-value="setMaxTurns"
          />
        </SettingsRow>
        <SettingsRow
          title="单次运行时长上限"
          description="Claude Code 或 Codex 一次运行超过这个时长就停止，结果里写明是超时。"
        >
          <Select
            :model-value="
              String(Math.round(config.limits.runTimeoutMs / 60_000))
            "
            :options="timeoutOptions"
            size="sm"
            data-run-timeout
            aria-label="单次运行时长上限"
            :disabled="busy"
            @update:model-value="setRunTimeout"
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup
        title="开发环境"
        description="子智能体在隔离的主目录里运行，默认只带上 git 身份和网络代理；其余按需打开。"
        data-executor-dev-env
      >
        <SettingsRow
          v-for="row in DEV_ENV_ROWS"
          :key="row.key"
          :title="row.title"
          :description="row.description"
        >
          <Switch
            :model-value="devEnv(row.key)"
            :data-dev-env="row.key"
            :disabled="busy"
            :aria-label="row.title"
            @update:model-value="setDevEnv(row.key, $event)"
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup v-if="claude" title="Claude Code">
        <SettingsRow
          title="使用本机安装的 claude"
          :description="`默认使用随 Emperor 发布的 Claude Code，不受本机 CLI 自动更新影响。改用本机安装的 claude 时需要 ${claudeFacts.probe?.requiredVersion ?? '>= 2.1'}。`"
        >
          <Switch
            :model-value="!usesBundledClaude(claude)"
            data-claude-installed-binary
            aria-label="使用本机安装的 claude"
            :disabled="busy"
            @update:model-value="setInstalledClaude"
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="排查">
        <SettingsRow
          title="验证后再应用"
          description="子智能体的成果先收集回执、运行你指定的验证命令并生成整合预览，再在任务详情里应用。关闭时，成果卡上的「应用到项目」直接合并改动，可以撤销。"
          data-executor-verify-first
        >
          <Switch
            :model-value="config.verifyBeforeApply === true"
            data-verify-before-apply
            aria-label="验证后再应用"
            :disabled="busy"
            @update:model-value="setVerifyFirst"
          />
        </SettingsRow>
        <SettingsRow
          title="诊断模式"
          description="停止 Claude Code 或 Codex 时，额外查找并停止离开了它进程组的进程。排查问题时再打开。"
        >
          <Switch
            :model-value="config.diagnosticsMode === true"
            data-diagnostics-mode
            aria-label="诊断模式"
            :disabled="busy"
            @update:model-value="setDiagnostics"
          />
        </SettingsRow>
      </SettingsGroup>
    </template>
  </SettingsSection>
</template>
