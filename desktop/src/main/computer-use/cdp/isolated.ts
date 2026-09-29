/**
 * Runs registry functions (`isolated-functions.ts`) in an isolated world per
 * frame, so page scripts cannot observe or tamper with the driver's own
 * helpers. Execution contexts die with navigation; a stale context is
 * recreated once.
 */

import { UiError } from '@emperor/core/host-capabilities'
import {
  CONTAINS_NODE_SOURCE,
  isolatedCall,
  type IsolatedFunctionName,
} from './isolated-functions'
import type { CdpSession } from './session'

const WORLD = 'emperor-computer-use'

export class IsolatedWorlds {
  private readonly contexts = new Map<string, number>()

  /**
   * `sessionFor` names the CDP session that owns a frame: undefined for the
   * page's own process, a child session for cross-origin (OOPIF) frames.
   */
  constructor(
    private readonly cdp: CdpSession,
    private readonly sessionFor: (frameId: string) => string | undefined = () =>
      undefined,
  ) {}

  private options(
    frameId: string,
    signal?: AbortSignal,
  ): { sessionId?: string; signal?: AbortSignal } {
    const sessionId = this.sessionFor(frameId)
    return {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /** Forget every context (main-frame navigation). */
  reset(): void {
    this.contexts.clear()
  }

  private async contextFor(
    frameId: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const known = this.contexts.get(frameId)
    if (known !== undefined) return known
    const { executionContextId } = await this.cdp.send<{
      executionContextId: number
    }>(
      'Page.createIsolatedWorld',
      { frameId, worldName: WORLD, grantUniveralAccess: false },
      this.options(frameId, signal),
    )
    this.contexts.set(frameId, executionContextId)
    return executionContextId
  }

  /** Call a registry function with `this` = the global object of `frameId`. */
  async callInFrame<T>(
    frameId: string,
    name: IsolatedFunctionName,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const call = isolatedCall(name, args)
    return await this.retry(frameId, async () => {
      const executionContextId = await this.contextFor(frameId, signal)
      const result = await this.cdp.send<{
        result?: { value?: unknown }
        exceptionDetails?: { text?: string }
      }>(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: call.source,
          executionContextId,
          arguments: call.args.map((value) => ({ value })),
          returnByValue: true,
          silent: true,
        },
        this.options(frameId, signal),
      )
      if (result.exceptionDetails !== undefined)
        throw new UiError('DRIVER_UNAVAILABLE', `${name} failed in the page`)
      return result.result?.value as T
    })
  }

  /** Call a registry function with `this` = the element. */
  async callOnElement<T>(
    frameId: string,
    backendNodeId: number,
    name: IsolatedFunctionName,
    args: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const call = isolatedCall(name, args)
    if (!call.onElement) throw new Error(`${name} does not run on an element`)
    return await this.retry(frameId, async () => {
      const executionContextId = await this.contextFor(frameId, signal)
      const { object } = await this.cdp.send<{ object: { objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId, executionContextId, objectGroup: WORLD },
        this.options(frameId, signal),
      )
      if (object.objectId === undefined)
        throw new UiError(
          'STALE_ELEMENT',
          'the element is no longer in the page',
        )
      try {
        const result = await this.cdp.send<{
          result?: { value?: unknown }
          exceptionDetails?: { text?: string }
        }>(
          'Runtime.callFunctionOn',
          {
            functionDeclaration: call.source,
            objectId: object.objectId,
            arguments: call.args.map((value) => ({ value })),
            returnByValue: true,
            silent: true,
          },
          this.options(frameId, signal),
        )
        if (result.exceptionDetails !== undefined)
          throw new UiError('DRIVER_UNAVAILABLE', `${name} failed in the page`)
        return result.result?.value as T
      } finally {
        void this.cdp
          .send(
            'Runtime.releaseObjectGroup',
            { objectGroup: WORLD },
            this.options(frameId),
          )
          .catch(() => undefined)
      }
    })
  }

  /** Whether `nodeId` is `ancestorId` or inside it (composed tree). */
  async contains(
    frameId: string,
    ancestorId: number,
    nodeId: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (ancestorId === nodeId) return true
    return await this.retry(frameId, async () => {
      const executionContextId = await this.contextFor(frameId, signal)
      const options = this.options(frameId, signal)
      const resolve = async (backendNodeId: number): Promise<string> => {
        const { object } = await this.cdp.send<{
          object: { objectId?: string }
        }>(
          'DOM.resolveNode',
          { backendNodeId, executionContextId, objectGroup: WORLD },
          options,
        )
        if (object.objectId === undefined)
          throw new UiError(
            'STALE_ELEMENT',
            'the element is no longer in the page',
          )
        return object.objectId
      }
      try {
        const ancestor = await resolve(ancestorId)
        const node = await resolve(nodeId)
        const result = await this.cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.callFunctionOn',
          {
            functionDeclaration: CONTAINS_NODE_SOURCE,
            objectId: ancestor,
            arguments: [{ objectId: node }],
            returnByValue: true,
            silent: true,
          },
          options,
        )
        return result.result?.value === true
      } finally {
        void this.cdp
          .send(
            'Runtime.releaseObjectGroup',
            { objectGroup: WORLD },
            this.options(frameId),
          )
          .catch(() => undefined)
      }
    })
  }

  private async retry<T>(frameId: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      if (error instanceof UiError && error.reason === 'cdp-error') {
        // Most often a context destroyed by navigation: rebuild once.
        this.contexts.delete(frameId)
        try {
          return await body()
        } catch (retryError) {
          if (
            retryError instanceof UiError &&
            retryError.reason === 'cdp-error'
          )
            throw new UiError('STALE_ELEMENT', 'the element or frame is gone', {
              cause: retryError,
            })
          throw retryError
        }
      }
      throw error
    }
  }
}
