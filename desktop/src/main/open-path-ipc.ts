/**
 * `emperor:open-path` (MAIN-27): open a folder in Finder for 设置 › 诊断 and
 * 能力 › Skills. The renderer names what to open ({@link OpenPathTarget});
 * main asks Core where it is, so a renderer that got hijacked cannot use
 * `shell.openPath` to launch a downloaded program or any path it likes. An
 * app bundle (say a project folder called `Something.app`) is shown in
 * Finder rather than opened, which would launch it.
 */
import * as path from 'node:path'
import { OPEN_PATH_CHANNEL, type OpenPathTarget } from '../shared/ipc-contract'

export interface OpenPathSources {
  /** Emperor Home (the state root main itself uses). */
  emperorHome(): string
  /** The Build project of a session (the one the page was opened from), if any. */
  sessionProject(sessionId: string | null): string | null
  /** An installed Skill's folder in a session's scope, or null. */
  skillFolder(name: string, sessionId: string | null): string | null
  /** The rejected Skill folders and files Core lists for that scope. */
  invalidSkillPaths(sessionId: string | null): readonly string[]
}

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ): void
}

const NOT_ALLOWED = '这个位置不能打开'
const MISSING = '找不到这个文件夹'
const MAX_NAME = 256
const MAX_PATH = 4096
const BUNDLE =
  /\.(?:app|appex|bundle|framework|plugin|kext|prefpane|workflow|action|saver|qlgenerator|mdimporter|xpc|mpkg|pkg)$/i

export function parseOpenPathTarget(payload: unknown): OpenPathTarget | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const sessionId =
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    record.sessionId.length <= MAX_NAME
      ? record.sessionId
      : null
  switch (record.kind) {
    case 'diagnostic':
      return record.rowId === 'global-state-root' ||
        record.rowId === 'active-project-path'
        ? { kind: 'diagnostic', rowId: record.rowId, sessionId }
        : null
    case 'skill':
      return typeof record.name === 'string' &&
        record.name.length > 0 &&
        record.name.length <= MAX_NAME
        ? { kind: 'skill', name: record.name, sessionId }
        : null
    case 'invalid-skill':
      return typeof record.path === 'string' &&
        path.isAbsolute(record.path) &&
        record.path.length <= MAX_PATH
        ? { kind: 'invalid-skill', path: record.path, sessionId }
        : null
    default:
      return null
  }
}

/** The folder Core gives for `target`, or null when it vouches for none. */
export function resolveOpenPathTarget(
  target: OpenPathTarget,
  sources: OpenPathSources,
): string | null {
  switch (target.kind) {
    case 'diagnostic':
      return target.rowId === 'global-state-root'
        ? sources.emperorHome() || null
        : sources.sessionProject(target.sessionId ?? null) || null
    case 'skill':
      return sources.skillFolder(target.name, target.sessionId ?? null)
    case 'invalid-skill': {
      const listed = sources
        .invalidSkillPaths(target.sessionId ?? null)
        .includes(target.path)
      if (!listed) return null
      // A rejected single-file Skill opens its folder (skillsModel.ts).
      return /\.md$/i.test(target.path)
        ? path.dirname(target.path)
        : target.path
    }
  }
}

export function registerOpenPathIpc(input: {
  ipcMain: IpcMainLike
  authorize(event: unknown): void
  sources: OpenPathSources
  isDirectory(target: string): boolean
  /** `shell.openPath`: '' on success, else the error. */
  openPath(target: string): Promise<string>
  showItemInFolder(target: string): void
}): void {
  input.ipcMain.handle(OPEN_PATH_CHANNEL, async (event, payload) => {
    input.authorize(event)
    const target = parseOpenPathTarget(payload)
    let folder: string | null = null
    try {
      folder = target ? resolveOpenPathTarget(target, input.sources) : null
    } catch {
      folder = null
    }
    if (!folder || !path.isAbsolute(folder))
      return { ok: false, error: NOT_ALLOWED }
    if (!input.isDirectory(folder)) return { ok: false, error: MISSING }
    if (BUNDLE.test(folder)) {
      input.showItemInFolder(folder)
      return { ok: true }
    }
    const error = await input.openPath(folder)
    return error ? { ok: false, error } : { ok: true }
  })
}
