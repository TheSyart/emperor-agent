/**
 * An unsigned app opened from its download location runs from a random,
 * read-only App Translocation path. The Preview's Computer Helper copy is
 * bound to the main executable's path, so computer use permissions would
 * reset at every launch; offer to move the app into Applications instead.
 */

export interface AppLocationDeps {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  readonly executablePath: string
  /** Resolves to the index of the button the user chose. */
  readonly ask: (options: {
    readonly message: string
    readonly detail: string
    readonly buttons: readonly string[]
  }) => Promise<number>
  /** Moves the app and relaunches it; false when it did not move. */
  readonly moveToApplications: () => boolean
}

export function isTranslocated(executablePath: string): boolean {
  return executablePath.includes('/AppTranslocation/')
}

/** True when the app is moving (and relaunching): stop starting up. */
export async function offerMoveToApplications(
  deps: AppLocationDeps,
): Promise<boolean> {
  if (
    deps.platform !== 'darwin' ||
    !deps.isPackaged ||
    !isTranslocated(deps.executablePath)
  )
    return false
  const choice = await deps.ask({
    message: '请把 Emperor Agent 移到「应用程序」文件夹',
    detail:
      '它现在是从下载位置直接打开的，macOS 会把它放在临时路径运行，电脑操作的授权每次启动都要重新授予。移动后会自动重新打开。',
    buttons: ['移到「应用程序」', '稍后'],
  })
  if (choice !== 0) return false
  try {
    return deps.moveToApplications()
  } catch (error) {
    console.error('moving Emperor Agent to Applications failed', error)
    return false
  }
}
