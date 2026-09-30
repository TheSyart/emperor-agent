/**
 * The user's built-in browser in real Electron (plan C 线, BR-02): a page
 * stores a cookie and site data in the `emperor-browser` partition and
 * shows up in the temporary history; 清空临时浏览数据 wipes the cookie,
 * storage, cache and history — and leaves the Agent's browser alone (a
 * persistent `session.fromPath` profile and a task partition, the way
 * browser-session-manager makes them).
 */

import { BrowserWindow, session, webContents, type WebContents } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_PARTITION,
  BrowserViewHost,
} from '../../../src/main/browser-view'
import { startFixtureSite } from '../fixtures/site'
import type { E2eResult } from './main'

const SUITE = 'userbrowser'

/** The user browser's page showing `path`, once it finished loading. */
async function loaded(path: string): Promise<WebContents> {
  const user = session.fromPartition(BROWSER_PARTITION)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const page = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          !contents.isDestroyed() &&
          contents.session === user &&
          new URL(contents.getURL() || 'about:blank').pathname === path &&
          !contents.isLoading(),
      )
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`the user browser never finished loading ${path}`)
}

const names = (cookies: Electron.Cookie[]) =>
  cookies.map((cookie) => cookie.name)

export async function runUserBrowser(
  report: (result: E2eResult) => void,
): Promise<void> {
  const site = await startFixtureSite()
  const window = new BrowserWindow({ show: false, width: 900, height: 700 })
  const host = new BrowserViewHost(window)
  const user = session.fromPartition(BROWSER_PARTITION)
  const profile = session.fromPath(
    mkdtempSync(join(tmpdir(), 'emperor-e2e-agent-profile-')),
  )
  const task = session.fromPartition('emperor-task-e2e-user-browser')
  const check = async (
    name: string,
    body: () => Promise<unknown>,
  ): Promise<void> => {
    const started = Date.now()
    try {
      const detail = await body()
      report({ suite: SUITE, name, ok: true, ms: Date.now() - started, detail })
    } catch (error) {
      report({
        suite: SUITE,
        name,
        ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  try {
    await check(
      'a page keeps a cookie and site data, and is in the history',
      async () => {
        await host.openUrl({ url: `${site.origin}/storage?set=user-1` })
        const page = await loaded('/storage')
        const state = await page.executeJavaScript(
          'document.getElementById("state").textContent',
        )
        const cookies = names(await user.cookies.get({}))
        const history = await host.history()
        if (
          !cookies.includes('cu_probe') ||
          state !== 'cookie=user-1 local=user-1'
        )
          throw new Error(`stored ${JSON.stringify({ cookies, state })}`)
        if (!history.some((entry) => entry.url.includes('/storage')))
          throw new Error(`history ${JSON.stringify(history)}`)
        return {
          state,
          cookies,
          history: history.length,
          cacheBytes: await user.getCacheSize(),
        }
      },
    )

    await check('the Agent profiles hold their own cookies', async () => {
      const expirationDate = Math.floor(Date.now() / 1000) + 3600
      await profile.cookies.set({
        url: site.origin,
        name: 'agent_profile',
        value: 'keep',
        expirationDate,
      })
      await task.cookies.set({
        url: site.origin,
        name: 'agent_task',
        value: 'keep',
      })
      return {
        profile: names(await profile.cookies.get({})),
        task: names(await task.cookies.get({})),
      }
    })

    await check(
      '清空 wipes the user browser and nothing of the Agent',
      async () => {
        const result = await host.clearData()
        const left = {
          result,
          state: host.clearState,
          user: names(await user.cookies.get({})),
          cacheBytes: await user.getCacheSize(),
          history: (await host.history()).length,
          profile: names(await profile.cookies.get({})),
          task: names(await task.cookies.get({})),
        }
        if (
          !result.ok ||
          left.user.length > 0 ||
          left.history > 0 ||
          !left.profile.includes('agent_profile') ||
          !left.task.includes('agent_task')
        )
          throw new Error(`after clearing ${JSON.stringify(left)}`)
        return left
      },
    )

    await check('a page opened afterwards finds nothing left', async () => {
      await host.openUrl({ url: `${site.origin}/storage` })
      const page = await loaded('/storage')
      const state = await page.executeJavaScript(
        'document.getElementById("state").textContent',
      )
      if (state !== 'cookie=none local=none')
        throw new Error(`the page still found ${state}`)
      return { state }
    })
  } finally {
    host.close()
    window.destroy()
    await site.close()
  }
}
