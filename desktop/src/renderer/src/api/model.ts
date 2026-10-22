import type {
  ModelConfigPayload,
  ModelDiscoveryResult,
  ModelEntrySaveInput,
  ModelExecutionPolicy,
  ModelProfilePreviewInput,
  ModelTestResult,
  ResolvedModelProfile,
} from '../types'
import type {
  CoreOperationArgs,
  ModelConnectionInput,
  ModelDefaultsInput,
  ModelDiscoveryPayload,
  ModelFacts,
  ModelFactsSource,
  ProbeResult,
} from '@emperor/core/api'
import { invokeCore } from './backend'

export async function saveModelEntry(
  entry: ModelEntrySaveInput,
): Promise<ModelConfigPayload> {
  return invokeCore('model.saveEntry', entry)
}

export async function saveModelPolicy(
  policy: ModelExecutionPolicy,
): Promise<ModelConfigPayload> {
  return invokeCore('model.savePolicy', policy)
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

export async function resolveModelProfilePreview(
  input: ModelProfilePreviewInput,
): Promise<ResolvedModelProfile> {
  return invokeCore('model.resolveProfile', input)
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

/** One cheap request with the draft connection (MOD-02). */
export async function probeModelConnection(
  connection: ModelConnectionInput,
): Promise<ProbeResult> {
  return invokeCore('model.probeConnection', connection)
}

/** The connection's models, merged with the bundled catalog (MOD-02). */
export async function listConnectionModels(
  connection: ModelConnectionInput & { refresh?: boolean },
): Promise<ModelDiscoveryPayload> {
  return invokeCore('model.discoverModels', connection)
}

/** Several models of one connection, one write (MOD-03). */
export type ModelEntriesSaveRequest = CoreOperationArgs<'model.saveEntries'>[0]

export async function saveModelEntries(
  input: ModelEntriesSaveRequest,
): Promise<ModelConfigPayload & { savedEntryIds: string[] }> {
  return invokeCore('model.saveEntries', input)
}

/** Catalog defaults for a model id typed in by hand (MOD-03). */
export async function lookupModelDefaults(
  input: ModelDefaultsInput,
): Promise<{ facts: ModelFacts; source: ModelFactsSource }> {
  return invokeCore('model.lookupDefaults', input)
}
