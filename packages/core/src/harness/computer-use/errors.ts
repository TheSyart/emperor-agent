/**
 * Computer Use error codes and their retry contract (spec 00 §5.6). Every
 * failure a GUI tool reports carries one of these codes, whether it is
 * retryable, and what the agent should do next.
 */

import { ToolError } from '../tools/definition'

interface UiErrorSpec {
  readonly retryable: boolean
  readonly hint: string
}

export const UI_ERROR_CODES = {
  CAPABILITY_DISABLED: {
    retryable: false,
    hint: 'Tell the user or ask for the capability; do not route around it.',
  },
  PERMISSION_REQUIRED: {
    retryable: false,
    hint: 'Wait for the user to decide in the UI.',
  },
  PERMISSION_DENIED: {
    retryable: false,
    hint: 'Stop; do not retry the same action another way.',
  },
  TARGET_FORBIDDEN: {
    retryable: false,
    hint: 'Protected target; stop and hand it to the user.',
  },
  TARGET_BUSY: {
    retryable: false,
    hint: 'Another task or the user holds this target; wait, do not preempt.',
  },
  TARGET_NOT_VISIBLE: {
    retryable: false,
    hint: 'Ask the user to bring the window forward, or use a semantic action.',
  },
  STALE_TARGET: {
    retryable: true,
    hint: 'The target changed; observe again before acting.',
  },
  STALE_ELEMENT: {
    retryable: true,
    hint: 'That element ref is from an older revision; observe again.',
  },
  SECURE_INPUT_ACTIVE: {
    retryable: false,
    hint: 'Secure input is active; hand this step to the user.',
  },
  USER_TAKEOVER: {
    retryable: false,
    hint: 'The user is controlling this target; wait until it is handed back.',
  },
  VISION_UNAVAILABLE: {
    retryable: false,
    hint: 'The current model cannot see images; use semantic actions.',
  },
  BUDGET_EXCEEDED: {
    retryable: false,
    hint: 'Action, rate or output budget exceeded; stop and report.',
  },
  DRIVER_UNAVAILABLE: {
    retryable: false,
    hint: 'The driver went away; stop and let the user recover it.',
  },
  PROTOCOL_MISMATCH: {
    retryable: false,
    hint: 'Helper and app versions do not match; the app needs an update.',
  },
  TIMEOUT_NO_EFFECT: {
    retryable: true,
    hint: 'Timed out without effect; observe again before deciding to retry.',
  },
  OUTCOME_UNKNOWN: {
    retryable: false,
    hint: 'The action may have happened; observe first, never replay blindly.',
  },
  PLAN_MODE_ACTION_DENIED: {
    retryable: false,
    hint: 'Plan mode is on; keep planning read-only.',
  },
  INVALID_REQUEST: {
    retryable: false,
    hint: 'Fix the request arguments.',
  },
} as const satisfies Record<string, UiErrorSpec>

export type UiErrorCode = keyof typeof UI_ERROR_CODES

export function isUiErrorCode(value: unknown): value is UiErrorCode {
  return typeof value === 'string' && Object.hasOwn(UI_ERROR_CODES, value)
}

/** Structured error payload returned in tool results. */
export interface UiErrorPayload {
  readonly code: UiErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly hint: string
  readonly reason?: string
}

export class UiError extends ToolError {
  declare readonly code: UiErrorCode
  readonly retryable: boolean
  readonly hint: string
  /** Machine-readable detail, e.g. `credential-binding-mismatch`. */
  readonly reason?: string

  constructor(
    code: UiErrorCode,
    message: string,
    options?: { reason?: string; hint?: string; cause?: unknown },
  ) {
    super(
      message,
      code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'UiError'
    this.retryable = UI_ERROR_CODES[code].retryable
    this.hint = options?.hint ?? UI_ERROR_CODES[code].hint
    if (options?.reason !== undefined) this.reason = options.reason
  }

  toPayload(): UiErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      hint: this.hint,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    }
  }
}

/** One-line text form used where only a string reaches the model (gate denials). */
export function uiErrorLine(error: UiError): string {
  const reason = error.reason === undefined ? '' : `; reason: ${error.reason}`
  return `computer-use ${error.code}: ${error.message} (retryable: ${error.retryable}${reason}; hint: ${error.hint})`
}

/** Normalize anything thrown by a driver into a {@link UiError}. */
export function asUiError(
  error: unknown,
  fallback: UiErrorCode = 'DRIVER_UNAVAILABLE',
): UiError {
  if (error instanceof UiError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new UiError(fallback, message, { cause: error })
}
