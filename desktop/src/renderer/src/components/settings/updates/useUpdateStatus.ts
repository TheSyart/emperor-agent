/**
 * The update status for 设置 › 常规 and the bell's update row (REL-02):
 * one copy for the window, read from Core (`updates.status`) on first use
 * and kept current by its `update_status` host events. The actions are
 * Core's: the switch, 立即检查, 下载 / 取消, 在访达中显示. 查看更新说明 opens
 * the release page like any other web link. Loaded with the settings
 * section or the notifications popover, never at startup.
 */
import { ref, type Ref } from 'vue'
import type { UpdateStatus } from '@emperor/core/runtime-contract'
import { onCoreEvent, openLink } from '../../../api/backend'
import { core } from '../../../api/http'

type Action = 'switch' | 'check' | 'download' | 'cancel' | 'reveal' | 'notes'

const status = ref<UpdateStatus | null>(null)
const error = ref('')
const busy = ref<Action | null>(null)
let subscribed = false
let loading: Promise<void> | null = null

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function follow(): void {
  if (subscribed) return
  subscribed = true
  onCoreEvent((event) => {
    const data = event as { event?: unknown; status?: unknown }
    if (data?.event === 'update_status' && data.status)
      status.value = data.status as UpdateStatus
  })
}

async function load(): Promise<void> {
  follow()
  loading ??= core('updates.status')
    .then((value) => {
      status.value = value
      error.value = ''
    })
    .catch((cause: unknown) => {
      error.value = `读取更新状态失败：${messageOf(cause)}`
    })
    .finally(() => {
      loading = null
    })
  await loading
}

async function run(
  action: Action,
  call: () => Promise<UpdateStatus | void>,
): Promise<boolean> {
  if (busy.value) return false
  busy.value = action
  try {
    const next = await call()
    if (next) status.value = next
    error.value = ''
    return true
  } catch (cause) {
    error.value = messageOf(cause)
    return false
  } finally {
    busy.value = null
  }
}

export interface UpdateStatusApi {
  status: Ref<UpdateStatus | null>
  error: Ref<string>
  busy: Ref<Action | null>
  load: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<boolean>
  check: () => Promise<boolean>
  download: () => Promise<boolean>
  cancel: () => Promise<boolean>
  reveal: () => Promise<boolean>
  openNotes: () => Promise<boolean>
}

export function useUpdateStatus(): UpdateStatusApi {
  return {
    status,
    error,
    busy,
    load,
    setEnabled: (enabled) =>
      run('switch', () => core('updates.setEnabled', enabled)),
    check: () => run('check', () => core('updates.check')),
    download: () => run('download', () => core('updates.download')),
    cancel: () => run('cancel', () => core('updates.cancelDownload')),
    reveal: () => run('reveal', () => core('updates.reveal')),
    openNotes: () =>
      run('notes', async () => {
        const url = status.value?.available?.notesUrl
        if (url) await openLink(url)
      }),
  }
}

/** Test hook: forget the window's copy. */
export function resetUpdateStatusForTest(): void {
  status.value = null
  error.value = ''
  busy.value = null
  subscribed = false
  loading = null
}
