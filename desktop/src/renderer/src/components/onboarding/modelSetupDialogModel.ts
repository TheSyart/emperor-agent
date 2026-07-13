import type { BootstrapPayload } from '../../types'

export interface ModelSetupDialogContent {
  brandAlt: string
  title: string
  subtitle: string
  status: string
  primaryAction: string
  secondaryAction: string
  helperText: string
  heroAlt: string
}

const DEFAULT_STATUS = '还没有可用模型，请先配置模型。'

export function shouldShowModelSetupPrompt(
  payload: BootstrapPayload | null | undefined,
): boolean {
  return payload?.modelConfig?.availability?.usable === false
}

export function buildModelSetupDialogContent(
  message?: string | null,
): ModelSetupDialogContent {
  return {
    brandAlt: 'emperoragent',
    title: '把任务交给本地 Agent。',
    subtitle:
      '先接入一个可用模型，Emperor Agent 才能在本机会话中对话、调用工具、保存记忆并执行任务。',
    status: message?.trim() || DEFAULT_STATUS,
    primaryAction: '去配置模型',
    secondaryAction: '稍后配置',
    helperText: '模型配置会保存到本机私有数据目录。',
    heroAlt: 'Emperor Agent 本地工作台宣传图',
  }
}
