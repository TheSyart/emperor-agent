import { EmperorError } from '../errors'

/**
 * 控制流异常 (MIG-CTRL-011)。对齐 Python `agent/control/exceptions.py`。
 * TurnPaused: 暂停当前回合，携带 interaction + tool_messages。
 */
export class PlanGenerationFailedError extends EmperorError {
  constructor() {
    super(
      '计划生成失败：模型未通过 propose_plan 提交有效的结构化计划。请重试或补充约束。',
      'plan_generation_failed',
    )
  }
}

export class TurnPaused extends Error {
  readonly interaction: Record<string, unknown>
  readonly toolMessages: Array<Record<string, unknown>>

  constructor(
    interaction: Record<string, unknown>,
    toolMessages: Array<Record<string, unknown>> = [],
  ) {
    const kind = interaction.kind ?? 'interaction'
    const ident = interaction.id ?? 'unknown'
    super(`turn paused for ${kind}: ${ident}`)
    this.name = 'TurnPaused'
    this.interaction = interaction
    this.toolMessages = toolMessages
  }
}
