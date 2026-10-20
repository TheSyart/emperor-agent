import { contextBridge, ipcRenderer } from 'electron'
import {
  RECOVERY_ACTION_CHANNEL,
  type RecoveryAction,
} from '../shared/recovery-contract'

contextBridge.exposeInMainWorld('emperorRecovery', {
  /** `payload` is `{ id }` for the diagnostics bundle actions only. */
  action: (action: RecoveryAction, payload?: { id: string }) =>
    ipcRenderer.invoke(RECOVERY_ACTION_CHANNEL, action, payload),
})
