import { afterEach, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  acquireCodexAuth,
  codexAuthLockPath,
  linkCodexAuth,
  type CodexAuthLink,
} from './codex-auth'
import { delegationTestDirectory } from './testing'

// Every test uses a fake HOME under a temp directory: nothing here reads,
// writes or refreshes the user's real ~/.codex/auth.json.
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

function auth(refresh: string, lastRefresh: string, account = 'acct-1') {
  return (
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'access-' + refresh,
        refresh_token: refresh,
        id_token: 'id-' + refresh,
        account_id: account,
      },
      last_refresh: lastRefresh,
    }) + '\n'
  )
}

function fixture(): CodexAuthLink & { root: string } {
  const f = delegationTestDirectory()
  cleanups.push(f.cleanup)
  const home = join(f.root, 'fake-home', '.codex'),
    isolated = join(f.root, 'runtime', 'codex')
  mkdirSync(home, { recursive: true })
  mkdirSync(isolated, { recursive: true })
  writeFileSync(
    join(home, 'auth.json'),
    auth('refresh-0', '2026-10-10T00:00:00Z'),
    {
      mode: 0o600,
    },
  )
  return {
    root: f.root,
    source: join(home, 'auth.json'),
    isolated: join(isolated, 'auth.json'),
  }
}

const refreshOf = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')).tokens.refresh_token as string
const isLink = (link: CodexAuthLink) =>
  lstatSync(link.isolated).isSymbolicLink() &&
  readlinkSync(link.isolated) === link.source

it('links the isolated auth.json to the user file instead of copying the refresh token', () => {
  const link = fixture()
  expect(linkCodexAuth(link)).toBe('relinked')
  expect(isLink(link)).toBe(true)
  // Nothing under the isolated home holds a second copy of the token.
  const isolatedHome = join(link.isolated, '..')
  for (const name of readdirSync(isolatedHome)) {
    const path = join(isolatedHome, name)
    if (lstatSync(path).isFile())
      expect(readFileSync(path, 'utf8')).not.toContain('refresh-0')
  }
  expect(linkCodexAuth(link)).toBe('linked')
})

it('leaves an old forked copy for the locked lease, which copies back a newer token of the same account', async () => {
  const link = fixture()
  // An older build forked the token, and its process refreshed the copy.
  writeFileSync(link.isolated, auth('refresh-1', '2026-10-12T00:00:00Z'))
  expect(linkCodexAuth(link)).toBe('deferred')
  expect(lstatSync(link.isolated).isSymbolicLink()).toBe(false)
  const lease = (await acquireCodexAuth(link))!
  expect(refreshOf(link.source)).toBe('refresh-1')
  expect(statSync(link.source).mode & 0o777).toBe(0o600)
  expect(isLink(link)).toBe(true)
  await lease.release()
})

it('discards an old forked copy that is not newer, or belongs to another account', async () => {
  const link = fixture()
  writeFileSync(link.isolated, auth('refresh-old', '2026-10-01T00:00:00Z'))
  await (await acquireCodexAuth(link))!.release()
  expect(refreshOf(link.source)).toBe('refresh-0')
  expect(isLink(link)).toBe(true)
  renameSync(link.isolated, link.isolated + '.gone')
  writeFileSync(
    link.isolated,
    auth('refresh-other', '2026-10-30T00:00:00Z', 'acct-2'),
  )
  await (await acquireCodexAuth(link))!.release()
  expect(refreshOf(link.source)).toBe('refresh-0')
  expect(isLink(link)).toBe(true)
})

it('a refresh written through the link updates the user file and keeps the link', async () => {
  const link = fixture()
  linkCodexAuth(link)
  const lease = (await acquireCodexAuth(link, { checkMs: 10 }))!
  // Codex 0.153.x opens auth.json and writes it in place (it follows links).
  writeFileSync(link.isolated, auth('refresh-1', '2026-10-19T00:00:00Z'))
  expect(lease.check()).toBe('linked')
  await lease.release()
  expect(refreshOf(link.source)).toBe('refresh-1')
  expect(isLink(link)).toBe(true)
})

it('a refresh that replaces the link is copied back to the user file and the link restored', async () => {
  const link = fixture()
  linkCodexAuth(link)
  const lease = (await acquireCodexAuth(link, { checkMs: 60_000 }))!
  // A Codex that writes a temporary file and renames it over auth.json.
  writeFileSync(
    link.isolated + '.tmp',
    auth('refresh-1', '2026-10-19T00:00:00Z'),
  )
  renameSync(link.isolated + '.tmp', link.isolated)
  expect(lstatSync(link.isolated).isSymbolicLink()).toBe(false)
  expect(lease.check()).toBe('copied-back')
  expect(refreshOf(link.source)).toBe('refresh-1')
  expect(isLink(link)).toBe(true)
  // A second rotation in the same run is a successor of the first.
  writeFileSync(
    link.isolated + '.tmp',
    auth('refresh-2', '2026-10-19T01:00:00Z'),
  )
  renameSync(link.isolated + '.tmp', link.isolated)
  await lease.release()
  expect(refreshOf(link.source)).toBe('refresh-2')
  expect(isLink(link)).toBe(true)
})

it('when the user file changed meanwhile, their own login wins over the replaced copy', async () => {
  const link = fixture()
  linkCodexAuth(link)
  const lease = (await acquireCodexAuth(link, { checkMs: 60_000 }))!
  writeFileSync(link.isolated + '.tmp', auth('child', '2026-10-19T00:00:00Z'))
  renameSync(link.isolated + '.tmp', link.isolated)
  // The user's own Codex refreshed (or logged in again) at the same time.
  writeFileSync(link.source, auth('user', '2026-10-19T00:00:01Z'))
  expect(lease.check()).toBe('discarded')
  await lease.release()
  expect(refreshOf(link.source)).toBe('user')
  expect(isLink(link)).toBe(true)
})

it('a logout during the run is not undone', async () => {
  const link = fixture()
  linkCodexAuth(link)
  const lease = (await acquireCodexAuth(link, { checkMs: 60_000 }))!
  writeFileSync(link.isolated + '.tmp', auth('child', '2026-10-19T00:00:00Z'))
  renameSync(link.isolated + '.tmp', link.isolated)
  renameSync(link.source, link.source + '.logged-out')
  await lease.release()
  expect(existsSync(link.source)).toBe(false)
})

it('only one isolated Codex process holds the refresh lock at a time', async () => {
  const link = fixture()
  const first = (await acquireCodexAuth(link))!
  expect(existsSync(codexAuthLockPath(link))).toBe(true)
  expect(await acquireCodexAuth(link, { wait: false })).toBeUndefined()
  let second: Awaited<ReturnType<typeof acquireCodexAuth>> | 'pending' =
    'pending'
  const waiting = acquireCodexAuth(link, { pollMs: 5 }).then((lease) => {
    second = lease
    return lease
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(second).toBe('pending')
  await first.release()
  const lease = await waiting
  expect(lease).toBeDefined()
  await lease!.release()
  expect(existsSync(codexAuthLockPath(link))).toBe(false)
})

it('waiting for the lock can be cancelled', async () => {
  const link = fixture()
  const first = (await acquireCodexAuth(link))!
  const controller = new AbortController()
  const waiting = acquireCodexAuth(link, {
    signal: controller.signal,
    pollMs: 5,
  })
  controller.abort()
  await expect(waiting).rejects.toThrow('ABORTED')
  await first.release()
})

it('reclaims a lock left by a process that no longer exists', async () => {
  const link = fixture()
  writeFileSync(
    codexAuthLockPath(link),
    JSON.stringify({ pid: 999_999_999, token: 'dead', createdAt: Date.now() }),
  )
  const lease = await acquireCodexAuth(link, { wait: false })
  expect(lease).toBeDefined()
  await lease!.release()
})

it('never follows a foreign symlink when relinking', () => {
  const link = fixture()
  const elsewhere = join(link.root, 'elsewhere.json')
  writeFileSync(elsewhere, auth('foreign', '2026-10-19T00:00:00Z'))
  symlinkSync(elsewhere, link.isolated)
  expect(linkCodexAuth(link)).toBe('relinked')
  expect(isLink(link)).toBe(true)
  expect(refreshOf(elsewhere)).toBe('foreign')
})
