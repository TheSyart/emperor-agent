<script setup lang="ts">
/**
 * 设置 › 子智能体 › 高级 (AGT-10): what most people never change — the
 * development environment a task may use (AGT-08) and the switches for
 * tracking problems down (验证后再应用, 诊断模式). Saved at once. A run's
 * longest time and Claude Code's turns moved to 设置 › 用量与费用 (SET-01);
 * a link row leads there. (Claude Code is always the installed one since
 * AGT-12: there is no binary to choose.)
 */
import type { ExecutorConfig } from '@emperor/core/runtime-contract'
import {
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSection,
  Switch,
} from '../ui'
import { useSettingsRoute } from '../useSettingsRoute'
import { useExecutorSettings } from './useExecutorSettings'

const s = useExecutorSettings()
const { config, busy } = s
const { openSettings } = useSettingsRoute()

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
      <SettingsGroup>
        <SettingsLinkRow
          title="运行时长与次数"
          description="费用和限制在「用量与费用」里统一设置"
          data-usage-link
          @click="openSettings('tokens')"
        />
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
