import type {
  ModelConfigPayload,
  ModelDiscoveryResult,
  ModelEntrySaveInput,
  ModelTestResult,
} from '../types'
import { invokeCore } from './backend'

export async function saveModelEntry(
  entry: ModelEntrySaveInput,
): Promise<ModelConfigPayload> {
  return invokeCore('model.saveEntry', entry)
}

export async function deleteModelEntry(
  entryId: string,
): Promise<ModelConfigPayload> {
  return invokeCore('model.deleteEntry', { entryId })
}

export async function activateModelEntry(
  entryId: string,
): Promise<ModelConfigPayload> {
  return invokeCore('model.activate', { entryId })
}

export async function setModelReasoningEffort(
  entryId: string,
  reasoningEffort: string | null,
): Promise<ModelConfigPayload> {
  return invokeCore('model.setReasoningEffort', {
    entryId,
    reasoningEffort,
  })
}

export async function testModelEntry(
  entryId: string,
  kind: 'text' | 'vision',
): Promise<ModelTestResult> {
  const result = await invokeCore('model.test', { entryId, kind })
  return {
    ok: Boolean(result.ok),
    kind,
    ...(typeof result.entryId === 'string' ? { entryId: result.entryId } : {}),
    ...(typeof result.latencyMs === 'number'
      ? { latencyMs: result.latencyMs }
      : {}),
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
    ...(typeof result.provider === 'string'
      ? { provider: result.provider }
      : {}),
    ...(typeof result.sample === 'string' ? { sample: result.sample } : {}),
    ...(typeof result.finishReason === 'string'
      ? { finishReason: result.finishReason }
      : {}),
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
  }
}

export async function discoverProviderModels(settings: {
  entryId?: string
  provider?: string
  protocol?: 'openai' | 'anthropic'
  apiBase?: string
  apiKey?: string | null
  extraHeaders?: Record<string, unknown> | null
}): Promise<ModelDiscoveryResult> {
  const { extraHeaders, ...typed } = settings
  return invokeCore('model.discoverModels', {
    ...typed,
    ...(extraHeaders
      ? {
          extraHeaders: Object.fromEntries(
            Object.entries(extraHeaders).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }
      : {}),
  })
}
