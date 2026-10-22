/**
 * Permissions of the default session (MAIN-3): the main window, the pet,
 * the pointer overlay and the recovery window. Electron grants every
 * permission request unless a handler says otherwise, so a script that got
 * into the renderer could open the microphone or camera. Emperor's own
 * windows need none of that (dictation records in its own helper, Computer
 * Use previews arrive over IPC, the browsers have their own sessions with
 * their own rules), so everything is denied except writing text to the
 * clipboard from the main window, which its copy buttons use.
 */
export interface DefaultSessionPermissionOptions {
  /**
   * `contents` is the main window's webContents and shows Emperor's own page
   * (app://bundle or the dev server). Checked on the page itself: the origin
   * Electron reports for app: comes out of Node's URL as "null".
   */
  isTrustedMainRenderer(contents: unknown): boolean
}

const MAIN_WINDOW_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
])

/** An `allowPermission` for session-hardening.ts' hardenSession. */
export function defaultSessionPermission(
  options: DefaultSessionPermissionOptions,
): (
  contents: unknown,
  permission: string,
  origin: string,
  mediaTypes: readonly string[],
) => boolean {
  return (contents, permission) =>
    MAIN_WINDOW_PERMISSIONS.has(permission) &&
    contents !== null &&
    contents !== undefined &&
    options.isTrustedMainRenderer(contents)
}
