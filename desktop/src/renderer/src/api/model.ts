import type {
  ModelConfigPayload,
  ModelDiscoveryResult,
  ModelTestResult,
} from '../types'
import { invokeCore } from './backend'

export async function saveOnboardingModelConfig(
  settings: Record<string, unknown>,
): Promise<ModelConfigPayload> {
  return invokeCore('model.saveOnboardingConfig', settings)
}

export async function testModelEntry(
  entryName: string,
  kind: 'text' | 'vision',
  role: 'main' | 'secondary' = 'main',
): Promise<ModelTestResult> {
  const result = await invokeCore('model.test', {
    entryName,
    kind,
    role,
  })
  return {
    ok: Boolean(result.ok),
    kind,
    ...(typeof result.latencyMs === 'number'
      ? { latencyMs: result.latencyMs }
      : {}),
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
    ...(typeof result.modelRole === 'string'
      ? { modelRole: result.modelRole }
      : {}),
    ...(typeof result.provider === 'string'
      ? { provider: result.provider }
      : {}),
    ...(typeof result.sample === 'string' ? { sample: result.sample } : {}),
    ...(typeof result.finishReason === 'string'
      ? { finishReason: result.finishReason }
      : {}),
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
    ...(typeof result.visionMarked === 'boolean'
      ? { visionMarked: result.visionMarked }
      : {}),
  }
}

export async function discoverProviderModels(
  settings: Record<string, unknown>,
): Promise<ModelDiscoveryResult> {
  return invokeCore('model.discoverModels', settings)
}
