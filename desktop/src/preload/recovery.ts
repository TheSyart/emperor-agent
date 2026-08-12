import { contextBridge, ipcRenderer } from 'electron'
import {
  RECOVERY_ACTION_CHANNEL,
  type RecoveryAction,
} from '../shared/recovery-contract'

contextBridge.exposeInMainWorld('emperorRecovery', {
  action: (action: RecoveryAction) =>
    ipcRenderer.invoke(RECOVERY_ACTION_CHANNEL, action),
})
