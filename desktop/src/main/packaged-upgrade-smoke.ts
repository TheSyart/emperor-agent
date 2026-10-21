/**
 * REL-04 (MAIN-29, card test 7): the packaged app started on an Emperor
 * Home written by 0.1.0-preview.4 (packages/core/fixtures/
 * emperor-home-0.1.0-preview.4, copied by the smoke runner into a temp state
 * root). Every session must list and read, and its last reply must show in
 * the window; the model and the long-term memory must still be there. The
 * receipt carries hashes, not text, and the runner compares them with the
 * fixture's fixture.json. Runs with `--emperor-smoke-scenario upgrade`.
 */
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from '@emperor/core/host-capabilities'

export interface PackagedUpgradeSmokeCore {
  sessions: {
    list(): unknown
    history(input: { sessionId: string; maxMessages?: number }): unknown
  }
  memory: { get(view: { sessionId: string | null }): unknown }
  model: { getConfig(): Promise<unknown> }
}

export interface PackagedUpgradeSmokeReceipt {
  schemaVersion: 1
  scenario: 'upgrade'
  exitCode: 0 | 1
  sessions: Array<{
    id: string
    title: string
    userMessages: number
    assistantMessages: number
    lastAssistantSha256: string
    rendered: boolean
  }>
  model: {
    count: number
    active: { modelId: string; displayName: string } | null
  }
  memory: { bytes: number; lineSha256: string[] }
  error?: { code: 'smoke_failed'; message: string }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function text(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      const value = asRecord(part).text
      return typeof value === 'string' ? value : ''
    })
    .join('')
}

/** The user's own messages and the replies in a page of session events. */
function messages(page: unknown): { users: number; replies: string[] } {
  const events = Array.isArray(asRecord(page).events)
    ? (asRecord(page).events as unknown[]).map(asRecord)
    : []
  let users = 0
  const replies: string[] = []
  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type === 'user/message' && asRecord(data.source).kind === 'user')
      users++
    if (event.type === 'assistant/message')
      replies.push(text(asRecord(data.message).content))
  }
  return { users, replies }
}

export async function runPackagedUpgradeSmoke(opts: {
  core: PackagedUpgradeSmokeCore
  receiptPath: string
  /** Shows a session in a window; true once `text` is on screen. */
  showSession(sessionId: string, text: string): Promise<boolean>
}): Promise<PackagedUpgradeSmokeReceipt> {
  try {
    const rows = await opts.core.sessions.list()
    const listed = (Array.isArray(rows) ? rows : [])
      .map(asRecord)
      .filter((row) => typeof row.id === 'string')
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    if (!listed.length)
      throw new Error('the upgraded Emperor Home lists no sessions')
    const sessions: PackagedUpgradeSmokeReceipt['sessions'] = []
    for (const row of listed) {
      const id = String(row.id)
      let read: { users: number; replies: string[] }
      try {
        read = messages(
          await opts.core.sessions.history({ sessionId: id, maxMessages: 200 }),
        )
      } catch (error) {
        throw new Error(
          `session ${id} could not be read: ${(error as Error).message}`,
        )
      }
      const last = read.replies.at(-1)
      if (last === undefined) throw new Error(`session ${id} has no reply`)
      if (!(await opts.showSession(id, last)))
        throw new Error(`session ${id} was not shown in the window`)
      sessions.push({
        id,
        title: typeof row.title === 'string' ? row.title : '',
        userMessages: read.users,
        assistantMessages: read.replies.length,
        lastAssistantSha256: sha256(last),
        rendered: true,
      })
    }
    const config = asRecord(await opts.core.model.getConfig())
    const models = (Array.isArray(config.models) ? config.models : []).map(
      asRecord,
    )
    const active = models.find(
      (entry) => entry.entryId === config.activeModelId,
    )
    const memory = String(
      asRecord(opts.core.memory.get({ sessionId: null })).long_term ?? '',
    )
    const receipt: PackagedUpgradeSmokeReceipt = {
      schemaVersion: 1,
      scenario: 'upgrade',
      exitCode: 0,
      sessions,
      model: {
        count: models.length,
        active: active
          ? {
              modelId: String(active.modelId ?? ''),
              displayName: String(active.displayName ?? ''),
            }
          : null,
      },
      memory: {
        bytes: Buffer.byteLength(memory),
        lineSha256: memory
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map(sha256),
      },
    }
    await writeJsonAtomic(opts.receiptPath, receipt)
    return receipt
  } catch (error) {
    const failed: PackagedUpgradeSmokeReceipt = {
      schemaVersion: 1,
      scenario: 'upgrade',
      exitCode: 1,
      sessions: [],
      model: { count: 0, active: null },
      memory: { bytes: 0, lineSha256: [] },
      error: {
        code: 'smoke_failed',
        message: 'Packaged upgrade smoke failed.',
      },
    }
    await writeJsonAtomic(opts.receiptPath, failed).catch(() => {})
    throw error
  }
}

export interface UpgradeSmokeWindowLike {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
  webContents: { executeJavaScript(source: string): Promise<unknown> }
}

/** Waits (up to 15 s) for `text` to appear in the page. */
export function sessionTextProbeSource(text: string): string {
  return `(async () => {
    const wanted = ${JSON.stringify(text)}
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if ((document.body?.innerText ?? '').includes(wanted)) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })()`
}

/** Opens app://bundle/chat/<id> in a window and waits for `text`. */
export async function verifySessionShown(opts: {
  createWindow(): UpgradeSmokeWindowLike
  sessionId: string
  text: string
}): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.sessionId))
    throw new Error(`not a plain session id: ${opts.sessionId}`)
  const win = opts.createWindow()
  try {
    await win.loadURL(`app://bundle/chat/${opts.sessionId}`)
    return (
      (await win.webContents.executeJavaScript(
        sessionTextProbeSource(opts.text),
      )) === true
    )
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
