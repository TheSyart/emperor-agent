import { CORE_EVENT_CHANNEL, PET_EVENT_CHANNEL } from '../shared/ipc-contract'
import { projectPetEvent } from './pet-event-projector'

export interface WebContentsLike {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

export class CoreEventBridge {
  private readonly targets = new Set<WebContentsLike>()
  private readonly petTargets = new Set<WebContentsLike>()

  attach(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.targets.add(webContents)
  }

  detach(webContents: WebContentsLike): void {
    this.targets.delete(webContents)
  }

  attachPet(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.petTargets.add(webContents)
  }

  detachPet(webContents: WebContentsLike): void {
    this.petTargets.delete(webContents)
  }

  emit(event: Record<string, unknown>): void {
    for (const target of [...this.targets]) {
      if (target.isDestroyed?.()) {
        this.targets.delete(target)
        continue
      }
      target.send(CORE_EVENT_CHANNEL, event)
    }
    const petEvent = projectPetEvent(event)
    if (!petEvent) return
    for (const target of [...this.petTargets]) {
      if (target.isDestroyed?.()) {
        this.petTargets.delete(target)
        continue
      }
      target.send(PET_EVENT_CHANNEL, petEvent)
    }
  }

  sink(): (event: Record<string, unknown>) => void {
    return (event) => this.emit(event)
  }

  size(): number {
    return this.targets.size
  }

  petSize(): number {
    return this.petTargets.size
  }
}
