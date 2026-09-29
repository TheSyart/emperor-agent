/**
 * M2.7 restart recovery in real Electron (spec 00 §7.1). Two separate
 * Electron processes share one Emperor Home and one userData directory, like
 * two launches of the app. Each runs a real CoreApi (scripted model) whose
 * Computer Use port is the desktop `DesktopComputerUsePort` around a real
 * `EmbeddedBrowserDriver` laid out as in `src/main/index.ts`.
 *
 *   before  create a persistent profile; the Agent opens `/storage?set=…` in
 *           it (the page sets a cookie and localStorage), moves to the plain
 *           `/storage`, and also opens a temporary tab. Then the app's own
 *           shutdown order runs — `closeAgentBrowser(true)`
 *           (rememberRestorableTabs, driver.shutdown) then CoreApi.close —
 *           and the process quits normally (`app.quit`).
 *   after   a fresh host on the same state root: `browser_tab_list` offers
 *           the persistent tab (never the temporary one); `browser_open`
 *           with exactly what was offered gets a new targetId, and the page
 *           still sees the cookie and localStorage.
 *
 * `runRestartRecovery` (an extra case) spawns both phases; `runRestartPhase`
 * is the child side (`--mode=restart_phase`, see main.ts).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeApi } from '../../../../packages/core/src/api/test-helpers'
import { replyChunks } from '../../../../packages/core/src/harness/testing'
import type { GenerateOptions } from '../../../../packages/core/src/llm/types'
import { EmbeddedBrowserDriver } from '../../../src/main/computer-use/embedded-browser-driver'
import { electronBrowserFactory } from '../../../src/main/computer-use/electron-factory'
import { nativeImageCodec } from '../../../src/main/computer-use/images'
import {
  DesktopComputerUsePort,
  hostPlatform,
} from '../../../src/main/computer-use/port'
import type { FixtureSite } from '../fixtures/site'

const PHASE_TIMEOUT_MS = 120_000
const TURN_TIMEOUT_MS = 60_000

type Summary = Record<string, unknown>
type Block = { type: string; text?: string; content?: Block[] }

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Text blocks of the last tool result the model received. */
function toolBlocks(request: GenerateOptions): string[] {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const content = request.messages[index]?.content
    if (!Array.isArray(content)) continue
    const result = (content as Block[]).find(
      (block) => block.type === 'tool-result',
    )
    if (result !== undefined)
      return (result.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
  }
  return []
}

const toolText = (request: GenerateOptions): string =>
  toolBlocks(request).join('\n')

/** The JSON summary (first text block) of the last tool result. */
function summaryOf(request: GenerateOptions): Summary {
  const text = toolBlocks(request)[0] ?? '{}'
  return JSON.parse(text.slice(text.indexOf('{'))) as Summary
}

/** `cookie=… local=…` as the page printed it (JSON-escaped in the envelope). */
function storageState(text: string): string | null {
  return /cookie=[\w-]+ local=[\w-]+/.exec(text)?.[0] ?? null
}

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out (a grant card?)`)),
          TURN_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Child side

export async function runRestartPhase(): Promise<void> {
  const env = process.env
  const phase = env.CU_RESTART_PHASE
  const dir = env.CU_RESTART_DIR ?? ''
  const origin = env.CU_RESTART_ORIGIN ?? ''
  const value = env.CU_RESTART_VALUE ?? ''
  check(
    (phase === 'before' || phase === 'after') && dir && origin && value,
    'restart phase environment is incomplete',
  )
  const root = join(dir, 'root')
  const stateRoot = join(root, 'home')
  // The desktop layout (src/main/index.ts): profiles under Emperor Home.
  const driver = new EmbeddedBrowserDriver({
    electron: electronBrowserFactory(),
    images: nativeImageCodec,
    platform: hostPlatform(process.platform),
    profilesRoot: join(stateRoot, 'browser', 'profiles'),
  })
  const port = new DesktopComputerUsePort({
    platform: process.platform,
    embeddedBrowser: () => driver,
  })
  const results: Summary[] = []
  let profileId = env.CU_RESTART_PROFILE ?? ''
  let observed = ''
  let listed: Summary = {}
  let opened: Summary = {}
  const record =
    (next: (request: GenerateOptions) => Parameters<typeof replyChunks>[0]) =>
    (request: GenerateOptions) => {
      results.push(summaryOf(request))
      return replyChunks(next(request))
    }
  const replies =
    phase === 'before'
      ? [
          () =>
            replyChunks({
              tools: [
                {
                  name: 'browser_open',
                  args: {
                    url: `${origin}/storage?set=${value}`,
                    profile: profileId,
                  },
                },
              ],
            }),
          record(() => ({
            tools: [
              { name: 'browser_navigate', args: { url: `${origin}/storage` } },
            ],
          })),
          record(() => ({ tools: [{ name: 'browser_observe', args: {} }] })),
          record((request) => {
            observed = toolText(request)
            // A temporary tab too: it must never be offered after restart.
            return {
              tools: [
                { name: 'browser_open', args: { url: `${origin}/form` } },
              ],
            }
          }),
          record(() => ({ text: 'opened' })),
        ]
      : [
          () =>
            replyChunks({ tools: [{ name: 'browser_tab_list', args: {} }] }),
          record((request) => {
            listed = summaryOf(request)
            const offered = (
              (listed.restorable ?? []) as Array<{
                profile?: string
                url?: string
              }>
            )[0]
            // Reopen exactly what was offered, as the tool's hint says.
            return {
              tools: [
                {
                  name: 'browser_open',
                  args: {
                    url: offered?.url ?? `${origin}/missing`,
                    profile: offered?.profile ?? 'temporary',
                  },
                },
              ],
            }
          }),
          record((request) => {
            opened = summaryOf(request)
            return { tools: [{ name: 'browser_observe', args: {} }] }
          }),
          record((request) => {
            observed = toolText(request)
            return { text: 'reopened' }
          }),
        ]
  const fixture = await makeApi({
    root,
    stateRoot,
    replies,
    extra: {
      templatesDir: resolve(__dirname, '..', '..', 'templates'),
      computerUsePort: port,
      computerUseSettings: () => ({
        enabled: true,
        authorizationMode: 'unrestricted',
      }),
    },
  })
  const { api } = fixture
  const service = api.host.computerUse!.service
  let sessionId = env.CU_RESTART_SESSION ?? ''
  const output: Summary = { phase }
  if (phase === 'before') {
    const created = await api.computerUse.manageProfile({
      action: 'create',
      name: 'M2.7 restart',
    })
    profileId = created.profile!.profileId
    sessionId = String(api.sessions.create({ title: 'M2.7 restart' }).id)
  } else {
    // Before the model runs: the recovery hint as the fresh host reads it.
    output.offered = service.restorableFor(sessionId)
  }
  api.control.setPermissionMode('danger-full-access', sessionId)
  await within(
    api.chat.submit({
      content: phase === 'before' ? 'open the mailbox' : 'what was open?',
      sessionId,
    }),
    `${phase} turn`,
  )
  const live = (await api.computerUse.status()).targets.filter(
    (target) => target.state !== 'closed' && target.state !== 'lost',
  )
  const persistent = live.find((target) => target.profileId === profileId)
  Object.assign(output, {
    sessionId,
    profileId,
    results,
    observed: storageState(observed),
    live: live.map((target) => ({
      targetId: target.targetId,
      profileId: target.profileId,
      url: target.url,
    })),
    targetId: persistent?.targetId ?? null,
  })
  if (phase === 'after') {
    output.listed = listed
    output.opened = opened
    output.restorableAfterReopen = service.restorableFor(sessionId)
    const tab =
      persistent === undefined
        ? undefined
        : driver.manager.get(persistent.targetId)
    const cookies =
      tab === undefined
        ? []
        : await tab.session.cookies.get({ url: origin, name: 'cu_probe' })
    output.cookie = cookies[0]?.value ?? null
  }
  // The app's shutdown order (src/main/index.ts closeCoreHost):
  // closeAgentBrowser(true) → CoreApi.close(); then the app quits.
  service.rememberRestorableTabs()
  const closing = driver.shutdown()
  await api.close()
  await closing
  if (phase === 'before') {
    const file = join(stateRoot, 'browser', 'restorable.json')
    output.restorableFile = JSON.parse(readFileSync(file, 'utf8')) as unknown
    output.restorableMode = (statSync(file).mode & 0o777).toString(8)
  }
  process.stdout.write(`E2E-PHASE ${JSON.stringify(output)}\n`)
}

// ---------------------------------------------------------------------------
// Parent side (an extra case)

function runPhase(
  phase: 'before' | 'after',
  env: Record<string, string>,
): Promise<Summary> {
  return new Promise((resolvePhase, reject) => {
    const childEnv: Record<string, string> = {}
    for (const [key, item] of Object.entries(process.env))
      if (item !== undefined) childEnv[key] = item
    delete childEnv.ELECTRON_RUN_AS_NODE
    Object.assign(childEnv, env, { CU_RESTART_PHASE: phase })
    // This bundle (out-e2e/harness.cjs) in a new Electron process.
    const child = spawn(
      process.execPath,
      [__filename, '--mode=restart_phase'],
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const timer = setTimeout(() => child.kill('SIGKILL'), PHASE_TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const line = stdout
        .split('\n')
        .find((item) => item.startsWith('E2E-PHASE '))
      if (code === 0 && line !== undefined) {
        resolvePhase(JSON.parse(line.slice('E2E-PHASE '.length)) as Summary)
        return
      }
      const noise = /task_policy_set|Failed to load URL: devtools/
      const tail = [
        ...stdout.split('\n').filter((item) => item.startsWith('E2E-PHASE')),
        ...stderr.split('\n').filter((item) => item && !noise.test(item)),
      ]
        .join('\n')
        .slice(-1500)
      reject(
        new Error(
          `${phase} phase exited ${code ?? signal}${line === undefined ? ' without a result' : ''}: ${tail}`,
        ),
      )
    })
  })
}

export async function runRestartRecovery(site: FixtureSite): Promise<Summary> {
  const dir = mkdtempSync(join(tmpdir(), 'emperor-e2e-restart-'))
  const value = `kept-${Date.now().toString(36)}`
  const base = {
    CU_RESTART_DIR: dir,
    CU_RESTART_ORIGIN: site.origin,
    CU_RESTART_VALUE: value,
    // Same userData for both launches, like restarting the app.
    CU_RESTART_USER_DATA: join(dir, 'user-data'),
  }
  try {
    const before = await runPhase('before', base)
    const expected = `cookie=${value} local=${value}`
    const url = `${site.origin}/storage`
    const allOk = (results: unknown): boolean =>
      Array.isArray(results) &&
      results.length > 0 &&
      results.every((item) => (item as Summary).status === 'ok')
    check(
      allOk(before.results),
      `before-restart tools: ${JSON.stringify(before.results)}`,
    )
    check(
      before.observed === expected,
      `before restart the page saw ${String(before.observed)}`,
    )
    check(
      typeof before.targetId === 'string',
      `no persistent tab before restart: ${JSON.stringify(before.live)}`,
    )
    const file = before.restorableFile as {
      tabs?: Array<{ ownerSessionId: string; profileId: string; url: string }>
    }
    check(
      (file.tabs ?? []).length === 1 &&
        file.tabs![0]!.ownerSessionId === before.sessionId &&
        file.tabs![0]!.profileId === before.profileId &&
        file.tabs![0]!.url === url,
      `restorable.json holds ${JSON.stringify(file)}`,
    )
    check(
      before.restorableMode === '600',
      `restorable.json mode ${String(before.restorableMode)}`,
    )

    const after = await runPhase('after', {
      ...base,
      CU_RESTART_SESSION: String(before.sessionId),
      CU_RESTART_PROFILE: String(before.profileId),
    })
    const offered = after.offered as Array<{ profileId: string; url: string }>
    check(
      offered.length === 1 &&
        offered[0]!.profileId === before.profileId &&
        offered[0]!.url === url,
      `the fresh host offers ${JSON.stringify(offered)}`,
    )
    const listed = after.listed as {
      count?: number
      restorable?: Array<{ profile: string; url: string }>
    }
    check(
      listed.count === 0 &&
        listed.restorable?.length === 1 &&
        listed.restorable[0]!.profile === before.profileId &&
        listed.restorable[0]!.url === url,
      `browser_tab_list after restart: ${JSON.stringify(listed)}`,
    )
    check(
      allOk(after.results),
      `after-restart tools: ${JSON.stringify(after.results)}`,
    )
    const opened = after.opened as { status?: string; targetId?: string }
    check(
      opened.status === 'ok' && typeof opened.targetId === 'string',
      `reopen failed: ${JSON.stringify(opened)}`,
    )
    check(
      opened.targetId !== before.targetId && after.targetId === opened.targetId,
      `reopened target ${String(opened.targetId)} (before ${String(before.targetId)})`,
    )
    check(
      after.observed === expected,
      `after restart the page saw ${String(after.observed)}, expected ${expected}`,
    )
    check(after.cookie === value, `profile cookie ${String(after.cookie)}`)
    check(
      (after.restorableAfterReopen as unknown[]).length === 0,
      `still offered after reopening: ${JSON.stringify(after.restorableAfterReopen)}`,
    )
    return {
      beforeTarget: before.targetId,
      afterTarget: opened.targetId,
      offered: listed.restorable,
      before: before.observed,
      after: after.observed,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
