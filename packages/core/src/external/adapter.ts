import type { ExternalDeliveryResult, ExternalOutbound } from './models'

export interface ExternalSendContext {
  signal?: AbortSignal | null
}

export abstract class ExternalAdapter {
  name = 'external'
  display_name = 'External'

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  get capabilities(): Record<string, unknown> {
    return {}
  }

  status(): Record<string, unknown> {
    return {
      name: this.name,
      display_name: this.display_name,
      capabilities: { ...this.capabilities },
    }
  }

  abstract send(
    message: ExternalOutbound,
    context?: ExternalSendContext,
  ): Promise<ExternalDeliveryResult>
}
