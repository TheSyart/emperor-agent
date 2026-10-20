export const RECOVERY_ACTION_CHANNEL = 'emperor:bootstrap-recovery:action'

export type RecoveryAction =
  | 'retry'
  | 'open_emperor_home'
  | 'open_legacy_home'
  | 'switch_to_owner'
  | 'exit'
  /** REL-01: open main.log. */
  | 'open_logs'
  /** REL-01 导出诊断包: stage and list, then export / discard `{ id }`. */
  | 'prepare_diagnostics'
  | 'export_diagnostics'
  | 'discard_diagnostics'
