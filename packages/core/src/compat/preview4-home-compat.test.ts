// REL-04 test 7 at the Core level: the Emperor Home that Emperor
// 0.1.0-preview.4 itself wrote (fixtures/emperor-home-0.1.0-preview.4,
// see its fixture.json) opens in this Core: the sessions are listed and
// readable, a conversation goes on, the memory and the model are there.
// The packaged smoke starts the real app on the same fixture.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from '../api/core-api'
import { makeApi } from '../api/test-helpers'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(
  here,
  '..',
  '..',
  'fixtures',
  'emperor-home-0.1.0-preview.4',
)

interface Manifest {
  appVersion: string
  expect: {
    sessions: Array<{
      id: string
      title: string
      userMessages: number
      assistantMessages: number
      lastAssistantText: string
    }>
    model: { modelId: string; displayName: string }
    memoryLine: string
  }
  /** Each file's mode as preview.4 wrote it (octal); git keeps only 644/755. */
  modes: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(join(fixtureRoot, 'fixture.json'), 'utf8'),
) as Manifest

/** The fixture's home with its path tokens filled in (as the smoke runner does). */
function preview4Home(): string {
  const work = mkdtempSync(join(tmpdir(), 'emperor-preview4-'))
  const home = join(work, 'home')
  const source = join(fixtureRoot, 'home')
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [join(dir, entry.name)],
    )
  for (const file of walk(source)) {
    const target = join(home, relative(source, file))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      readFileSync(file, 'utf8')
        .split('__EMPEROR_HOME__')
        .join(home)
        .split('__PREVIEW4_RUNTIME__')
        .join(join(work, 'preview4-runtime')),
    )
    const mode = manifest.modes[relative(source, file)]
    if (!mode) throw new Error(`fixture.json records no mode for ${file}`)
    chmodSync(target, Number.parseInt(mode, 8))
  }
  return home
}

type Event = { type: string; data?: Record<string, unknown> }

function messages(events: Event[]) {
  const text = (content: unknown) =>
    (Array.isArray(content) ? content : [])
      .map((part) => (part as { text?: string }).text ?? '')
      .join('')
  const users = events.filter(
    (event) =>
      event.type === 'user/message' &&
      (event.data?.source as { kind?: string } | undefined)?.kind === 'user',
  )
  const replies = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) =>
      text((event.data?.message as { content?: unknown } | undefined)?.content),
    )
  return { users: users.length, replies }
}

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

describe('an Emperor Home from 0.1.0-preview.4', () => {
  it('lists and reads every session it had', async () => {
    const { api } = await makeApi({ stateRoot: preview4Home() })
    apis.push(api)
    const listed = api.sessions.list() as Array<{ id: string; title: string }>
    for (const expected of manifest.expect.sessions) {
      expect(listed.find((row) => row.id === expected.id)).toMatchObject({
        title: expected.title,
      })
      const page = api.sessions.history({ sessionId: expected.id })
      const { users, replies } = messages(page.events as Event[])
      expect(users, expected.id).toBe(expected.userMessages)
      expect(replies, expected.id).toHaveLength(expected.assistantMessages)
      expect(replies.at(-1)).toBe(expected.lastAssistantText)
    }
  })

  it('goes on with a preview.4 conversation', async () => {
    const { api } = await makeApi({
      stateRoot: preview4Home(),
      replies: [{ text: '升级后的第一条回复' }],
    })
    apis.push(api)
    const session = manifest.expect.sessions[0]!
    const result = await api.chat.submit({
      content: '升级以后还记得吗？',
      sessionId: session.id,
    })
    expect(result).toMatchObject({ content: '升级后的第一条回复' })
    const { users, replies } = messages(
      api.sessions.history({ sessionId: session.id }).events as Event[],
    )
    expect(users).toBe(session.userMessages + 1)
    expect(replies.at(-2)).toBe(session.lastAssistantText)
    expect(replies.at(-1)).toBe('升级后的第一条回复')
  })

  it('keeps its long-term memory and its model', async () => {
    const { api } = await makeApi({ stateRoot: preview4Home() })
    apis.push(api)
    const memory = api.memory.get({ sessionId: null }) as { long_term: string }
    expect(memory.long_term.split('\n')).toContain(manifest.expect.memoryLine)
    const config = (await api.model.getConfig()) as {
      activeModelId: string | null
      models: Array<{ entryId: string; modelId: string; displayName?: string }>
    }
    expect(
      config.models.find((entry) => entry.entryId === config.activeModelId),
    ).toMatchObject(manifest.expect.model)
  })
})
