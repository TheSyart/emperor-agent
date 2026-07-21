import {
  activeEntry,
  type ModelConfig,
  type ModelEntry,
  type ProviderConfig,
} from '../config/model-config'
import { ModelConfigurationError } from '../errors'
import { findByName } from '../providers/registry'

export interface ModelAvailability {
  usable: boolean
  code: 'model_configuration_required' | null
  message: string
  action: 'open_model_settings' | null
  provider: string | null
  entryName: string | null
}

export function modelAvailability(config: ModelConfig): ModelAvailability {
  if (!config.models.length) {
    return unavailable('还没有可用模型。请先配置模型后再开始对话。', null, null)
  }

  const entry = activeEntry(config) ?? null
  if (!entry) {
    return unavailable(
      '当前没有激活的模型条目。请到模型配置中选择或添加一个模型。',
      null,
      null,
    )
  }
  const providerName = String(entry.provider || '').trim() || null
  const mainModelId = String(entry.mainModelId || entry.id || '').trim()
  const entryName =
    String(
      entry.displayName ||
        entry.label ||
        entry.modelId ||
        entry.mainModelId ||
        entry.id ||
        entry.name ||
        '',
    ).trim() || null
  if (!mainModelId) {
    return unavailable(
      `模型条目「${entryName || '未命名'}」缺少 Main Model ID。请先补全模型配置。`,
      providerName,
      entryName,
    )
  }

  const spec = findByName(providerName) ?? findByName('custom')
  if (
    !spec?.isLocal &&
    !spec?.isOauth &&
    !credentialFor(entry, config.providers[spec?.name || providerName || ''])
  ) {
    return unavailable(
      `模型条目「${entryName || mainModelId}」缺少 API Key。请到模型配置中填写 ${spec?.displayName || providerName || 'Provider'} 的 API Key。`,
      spec?.name || providerName,
      entryName,
    )
  }

  return {
    usable: true,
    code: null,
    message: '模型已配置',
    action: null,
    provider: spec?.name || providerName,
    entryName,
  }
}

export function assertModelAvailable(
  availability: ModelAvailability | null | undefined,
): void {
  if (!availability || availability.usable) return
  throw new ModelConfigurationError(availability.message)
}

function unavailable(
  message: string,
  provider: string | null,
  entryName: string | null,
): ModelAvailability {
  return {
    usable: false,
    code: 'model_configuration_required',
    message,
    action: 'open_model_settings',
    provider,
    entryName,
  }
}

function credentialFor(
  entry: ModelEntry,
  provider: ProviderConfig | null | undefined,
): string {
  return String(entry.apiKey || provider?.apiKey || '').trim()
}
