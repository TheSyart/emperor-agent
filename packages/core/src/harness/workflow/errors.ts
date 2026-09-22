/**
 * Host-side workflow error (ported from dsh-workflow `WorkflowError`). The
 * worker realm has its own class of the same shape (see `runtime.ts`); only
 * rendered messages cross the thread boundary.
 */

import { HarnessError } from '../../llm/error'
import type { WorkflowErrorCode } from './types'

/**
 * Typed error for workflow-seam failures. `fatal` drives combinator
 * discipline: `parallel()`/`pipeline()` re-throw a fatal error instead of
 * nulling the item. Every {@link WorkflowErrorCode} is fatal by default.
 */
export class WorkflowError extends HarnessError {
  readonly fatal: boolean

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options?: ErrorOptions & { fatal?: boolean },
  ) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true
  }
}

/** Whether combinators must re-throw `error` instead of mapping the item to `null`. */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}
