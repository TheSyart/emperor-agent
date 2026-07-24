/**
 * 领域错误基类 (MIG-FND-008)。
 *
 * 对齐 Python 侧散落的 `class XxxError(ValueError/RuntimeError)`（SchedulerStoreCorrupt、
 * PlanQualityError、PlanEvidenceError 等）。所有错误可被 IPC 边界
 * 序列化为「安全错误」——只暴露 code/message，不泄内部细节。
 */
export interface SafeErrorPayload {
  code: string
  message: string
  action?: string
}

export interface EmperorErrorOptions extends ErrorOptions {
  action?: string | null
}

export class EmperorError extends Error {
  /** 稳定的机器可读错误码，用于 IPC/日志关联。 */
  readonly code: string
  /** 可选的前端动作提示，例如打开模型配置页。 */
  readonly action?: string

  constructor(
    message: string,
    code = 'emperor_error',
    options?: EmperorErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    if (options?.action) this.action = options.action
  }

  /** IPC 边界用：只回 code+message，绝不带内部栈。 */
  toSafe(): SafeErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.action ? { action: this.action } : {}),
    }
  }
}

/** 持久化文件损坏（解析失败）。对齐 Python `SchedulerStoreCorrupt` 等。 */
export class StoreCorruptError extends EmperorError {
  /** 被隔离的损坏文件备份路径（若已隔离）。 */
  readonly backupPath?: string

  constructor(message: string, backupPath?: string, options?: ErrorOptions) {
    super(message, 'store_corrupt', options)
    this.backupPath = backupPath
  }
}

/** 解析错误（如结构化模型输出不符合 schema）。 */
export class ParseError extends EmperorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'parse_error', options)
  }
}

/** 校验错误（schema / 不变量）。对齐 `PlanQualityError`/`PlanEvidenceError`。 */
export class ValidationError extends EmperorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'validation_error', options)
  }
}

/** 模型尚未配置到可用状态。 */
export class ModelConfigurationError extends EmperorError {
  constructor(
    message = '还没有可用模型，请先配置模型。',
    options?: ErrorOptions,
  ) {
    super(message, 'model_configuration_required', {
      ...options,
      action: 'open_model_settings',
    })
  }
}

export type ModelProviderErrorKind =
  'rate_limit' | 'auth' | 'transient' | 'permanent' | 'unknown'

/** Provider 最终失败，但可展示为用户可处理的安全错误。 */
export class ModelProviderError extends EmperorError {
  readonly providerErrorKind: ModelProviderErrorKind

  constructor(kind: ModelProviderErrorKind, options: { cause?: unknown } = {}) {
    super(providerErrorMessage(kind), `model_provider_${kind}`, {
      ...(options.cause instanceof Error ? { cause: options.cause } : {}),
      action: providerErrorAction(kind),
    })
    this.providerErrorKind = kind
  }
}

/** 当前 Agent step 的显式模型成本上限不允许再发起一次请求。 */
export class ModelCostCapExceededError extends EmperorError {
  constructor(message = '本轮模型成本上限已用尽，请提高上限或开始新一轮。') {
    super(message, 'model_cost_cap_exceeded', {
      action: 'open_model_settings',
    })
  }
}

/** 模型输入超过上下文窗口。 */
export class ContextOverflowError extends EmperorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'context_overflow', options)
  }
}

/** 把任意 throwable 归一成安全错误（IPC 出口用）。 */
export function toSafeError(err: unknown): SafeErrorPayload {
  if (err instanceof EmperorError) return err.toSafe()
  return { code: 'internal_error', message: '发生内部错误，请查看日志。' }
}

function providerErrorAction(kind: ModelProviderErrorKind): string | null {
  if (kind === 'auth') return 'open_model_settings'
  if (kind === 'rate_limit' || kind === 'transient') return 'retry_later'
  return null
}

function providerErrorMessage(kind: ModelProviderErrorKind): string {
  if (kind === 'auth')
    return '模型认证失败：API Key 无效或没有权限。请到模型配置检查 Provider、API Key 和模型 ID。'
  if (kind === 'rate_limit')
    return '模型服务触发限流。请稍后重试，或切换到可用额度更高的模型配置。'
  if (kind === 'transient') return '模型服务暂时不可用或网络超时。请稍后重试。'
  if (kind === 'permanent')
    return '模型请求失败。请检查模型 ID、API Base 和 Provider 配置。'
  return '模型调用失败。请检查模型配置或稍后重试。'
}
