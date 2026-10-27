/**
 * 新建群聊 (GRP-08): whether the dialog is open, one per window. The
 * sidebar's 新建群聊 (⌘N in Group), the 群聊 section's + and the Group
 * home's card open it; SidebarRoot renders it (its own chunk, loaded the
 * first time it opens).
 */
import { ref } from 'vue'

export const newGroupDialog = { open: ref(false) }

export function openNewGroupDialog(): void {
  newGroupDialog.open.value = true
}
