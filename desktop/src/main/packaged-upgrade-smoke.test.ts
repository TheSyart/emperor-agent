import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  runPackagedUpgradeSmoke,
  sessionTextProbeSource,
  verifySessionShown,
  type PackagedUpgradeSmokeCore,
} from './packaged-upgrade-smoke'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const user = (text: string) => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  },
})
const context = (text: string) => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context' },
  },
})
const reply = (text: string) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

function makeCore(overrides: Partial<PackagedUpgradeSmokeCore> = {}) {
  const histories: Record<string, unknown[]> = {
    a: [
      user('你好'),
      context('Current runtime context.'),
      reply('第一条回复'),
      user('再问'),
      reply('第二条回复'),
    ],
    b: [user('另一个'), reply('另一条回复')],
  }
  const core: PackagedUpgradeSmokeCore = {
    sessions: {
      list: vi.fn(() => [
        { id: 'b', title: '第二个会话' },
        { id: 'a', title: '升级测试会话' },
      ]),
      history: vi.fn(({ sessionId }: { sessionId: string }) => ({
        events: histories[sessionId] ?? [],
      })),
    },
    memory: {
      get: vi.fn(() => ({
        long_term: '# 长期记忆\n\n## Long-Term Projects\n\n- 夹具一行\n',
      })),
    },
    model: {
      getConfig: vi.fn(async () => ({
        activeModelId: 'm1',
        models: [
          {
            entryId: 'm1',
            modelId: 'deepseek-chat',
            displayName: 'DeepSeek（夹具）',
          },
        ],
      })),
    },
    ...overrides,
  }
  return core
}

const receiptPath = () =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-upgrade-unit-')),
    'r.json',
  )

describe('packaged smoke on a 0.1.0-preview.4 Emperor Home (REL-04 test 7)', () => {
  it('reads every session, shows its last reply, and reports hashes, not text', async () => {
    const shown: Array<[string, string]> = []
    const file = receiptPath()
    const receipt = await runPackagedUpgradeSmoke({
      core: makeCore(),
      receiptPath: file,
      showSession: async (id, text) => {
        shown.push([id, text])
        return true
      },
    })
    expect(receipt).toEqual({
      schemaVersion: 1,
      scenario: 'upgrade',
      exitCode: 0,
      sessions: [
        {
          id: 'a',
          title: '升级测试会话',
          userMessages: 2,
          assistantMessages: 2,
          lastAssistantSha256: sha('第二条回复'),
          rendered: true,
        },
        {
          id: 'b',
          title: '第二个会话',
          userMessages: 1,
          assistantMessages: 1,
          lastAssistantSha256: sha('另一条回复'),
          rendered: true,
        },
      ],
      model: {
        count: 1,
        active: { modelId: 'deepseek-chat', displayName: 'DeepSeek（夹具）' },
      },
      memory: {
        bytes: Buffer.byteLength(
          '# 长期记忆\n\n## Long-Term Projects\n\n- 夹具一行\n',
        ),
        lineSha256: [
          sha('# 长期记忆'),
          sha('## Long-Term Projects'),
          sha('- 夹具一行'),
        ],
      },
    })
    expect(shown).toEqual([
      ['a', '第二条回复'],
      ['b', '另一条回复'],
    ])
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(receipt)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('第二条回复')
  })

  it('fails closed when a session cannot be read', async () => {
    const file = receiptPath()
    const core = makeCore()
    core.sessions.history = vi.fn(() => {
      throw new Error('session log unrecoverable')
    })
    await expect(
      runPackagedUpgradeSmoke({
        core,
        receiptPath: file,
        showSession: async () => true,
      }),
    ).rejects.toThrow(/session a could not be read/)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      exitCode: 1,
      error: { code: 'smoke_failed' },
    })
  })

  it('fails closed on an empty Emperor Home', async () => {
    const core = makeCore()
    core.sessions.list = vi.fn(() => [])
    await expect(
      runPackagedUpgradeSmoke({
        core,
        receiptPath: receiptPath(),
        showSession: async () => true,
      }),
    ).rejects.toThrow(/no sessions/)
  })

  it('fails closed when the window does not show the reply', async () => {
    await expect(
      runPackagedUpgradeSmoke({
        core: makeCore(),
        receiptPath: receiptPath(),
        showSession: async () => false,
      }),
    ).rejects.toThrow(/session a was not shown/)
  })

  it('opens the session route in a window and waits for the reply text', async () => {
    let destroyed = false
    const win = {
      loadURL: vi.fn(async () => undefined),
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        destroyed = true
      }),
      webContents: { executeJavaScript: vi.fn(async () => true) },
    }
    expect(
      await verifySessionShown({
        createWindow: () => win,
        sessionId: 'd47212fe49d341ab',
        text: '记住了',
      }),
    ).toBe(true)
    expect(win.loadURL).toHaveBeenCalledWith(
      'app://bundle/chat/d47212fe49d341ab',
    )
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
      sessionTextProbeSource('记住了'),
    )
    expect(win.destroy).toHaveBeenCalledOnce()
  })

  it('refuses a session id that is not a plain id', async () => {
    await expect(
      verifySessionShown({
        createWindow: () => {
          throw new Error('must not open')
        },
        sessionId: '../settings',
        text: 'x',
      }),
    ).rejects.toThrow(/session id/)
  })
})
