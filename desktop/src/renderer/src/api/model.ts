import type { ModelConfigPayload, ModelTestResult } from '../types'
import { invokeCore } from './backend'

export async function saveOnboardingModelConfig(settings: Record<string, unknown>): Promise<ModelConfigPayload> {
  return invokeCore('model.saveOnboardingConfig', settings) as Promise<ModelConfigPayload>
}

export async function testModelEntry(
  entryName: string,
  kind: 'text' | 'vision',
  role: 'main' | 'secondary' = 'main',
): Promise<ModelTestResult> {
  return invokeCore('model.test', { entryName, kind, role }) as Promise<ModelTestResult>
}
