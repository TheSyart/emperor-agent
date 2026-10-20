// The composer's + › 截图 (UI-S04) over the preload bridge: main runs
// macOS's own region capture and hands back the PNG, which the composer
// attaches like a pasted image. Without the desktop bridge (or off macOS)
// there is no screenshot item.

import type { ScreenshotCaptureResult } from '../../../shared/ipc-contract'

interface ScreenshotBridge {
  platform?: string
  captureScreenshot?: () => Promise<ScreenshotCaptureResult>
}

function bridge(): ScreenshotBridge | undefined {
  return (globalThis as unknown as { window?: { emperor?: ScreenshotBridge } })
    .window?.emperor
}

export function screenshotSupported(): boolean {
  const current = bridge()
  return (
    current?.platform === 'darwin' &&
    typeof current.captureScreenshot === 'function'
  )
}

/**
 * Let the user pick a region (or a window). The picture as a file to
 * attach; null when they pressed Esc or a capture is already open.
 */
export async function captureScreenshot(): Promise<File | null> {
  const capture = bridge()?.captureScreenshot
  if (typeof capture !== 'function')
    throw new Error('截图只在 Emperor 桌面应用里可用')
  const result = await capture()
  if (result.ok)
    return new File([result.data as BlobPart], result.name, {
      type: result.mime,
    })
  if (result.reason === 'cancelled' || result.reason === 'busy') return null
  throw new Error(result.message || '截图失败')
}
