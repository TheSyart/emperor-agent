export const RECOVERY_ACTION_CHANNEL = 'emperor:bootstrap-recovery:action'

export type RecoveryAction =
  | 'retry'
  | 'open_emperor_home'
  | 'open_legacy_home'
  | 'switch_to_owner'
  | 'exit'
