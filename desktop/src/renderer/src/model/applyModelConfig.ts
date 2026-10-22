/**
 * Every model write returns the full model config payload; this applies it
 * to the bootstrap state (current model, provider, availability). Shared by
 * 设置 › 模型, the composer's model switch and the first-run guide.
 */
import type { BootstrapPayload, ModelConfigPayload } from '../types'

export function applyModelConfig(
  boot: BootstrapPayload | null | undefined,
  next: ModelConfigPayload,
): void {
  if (!boot) return
  boot.modelConfig = next
  boot.model = next.current?.modelId || ''
  boot.provider = next.current?.provider || undefined
  boot.providerLabel = next.current?.providerLabel || undefined
}
