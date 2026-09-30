import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '../llm/types'
import { replyChunks, type ScriptedReply } from '../harness/testing'
import { FakeComputerUsePort } from '../harness/computer-use/testing/fake-port'
import { PLUGIN_INVOCATION_PRODUCER } from '../harness/host/plugin-references'
import { messageText } from '../llm/message'
import {
  portablePackage,
  skillMarkdown,
  writePackage,
} from '../plugins/testing'
import { makeApi, tmp, type ApiFixture } from './test-helpers'
import type { CoreApiCreateOptions } from './core-api'

// E-track contract §3 through CoreApi: a user message naming `@plugin`
// reaches the model with the plugin's reference after it, the system
// prompt unchanged.

const REPO = join(__dirname, '..', '..', '..', '..')
const fixtures: ApiFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.api.close()
})

function runtimeRoot(): string {
  const root = tmp('emperor-plugin-refs-')
  cpSync(join(REPO, 'skills'), join(root, 'skills'), { recursive: true })
  cpSync(
    join(REPO, 'packages', 'core', 'bundled-plugins'),
    join(root, 'bundled-plugins'),
    { recursive: true },
  )
  return root
}

/** gh installed but logged out (exit code 4, as gh reports it). */
const GH_LOGGED_OUT: NonNullable<CoreApiCreateOptions['github']> = {
  resolveRuntime: async () => ({
    executable: '/fake/gh',
    env: {},
    version: '2.73.0',
  }),
  run: async () => ({
    exitCode: 4,
    stdout: '',
    stderr: 'To get started with GitHub CLI, please run:  gh auth login',
  }),
}

async function api(
  captured: GenerateOptions[],
  extra: Partial<CoreApiCreateOptions> = {},
) {
  const reply: ScriptedReply = (request) => {
    captured.push(request)
    return replyChunks({ text: 'ok' })
  }
  const fixture = await makeApi({
    root: runtimeRoot(),
    replies: Array.from({ length: 8 }, () => reply),
    extra: { github: GH_LOGGED_OUT, ...extra },
  })
  fixtures.push(fixture)
  return fixture
}

async function installHello(fixture: ApiFixture) {
  const source = writePackage(
    join(tmp('emperor-plugin-refs-src-'), 'hello-kit'),
    portablePackage(
      'hello-kit',
      {
        'skills/hello/SKILL.md':
          skillMarkdown('hello', 'Say hello') + 'HELLO-BODY\n',
      },
      { description: 'Greets people' },
    ),
  )
  const preview = await fixture.api.plugins.inspect({
    kind: 'local',
    path: source,
  })
  await fixture.api.plugins.install({
    previewId: preview.previewId,
    digest: preview.digest,
    scope: 'user',
  })
}

/** References this step injected: after the latest user message (earlier ones stay in history). */
function injected(request: GenerateOptions): Message[] {
  let last = -1
  request.messages.forEach((message, index) => {
    if (message.source.kind === 'user') last = index
  })
  return request.messages
    .slice(last + 1)
    .filter(
      (message) =>
        message.source.kind === 'context' &&
        message.source.producer === PLUGIN_INVOCATION_PRODUCER,
    )
}

async function ask(fixture: ApiFixture, sessionId: string, content: string) {
  await fixture.api.chat.submit({ content, sessionId })
}

describe('plugin references through CoreApi', () => {
  it("puts an enabled plugin's reference after the message, and keeps the system prompt", async () => {
    const captured: GenerateOptions[] = []
    const fixture = await api(captured)
    await installHello(fixture)
    const sessionId = String(fixture.api.sessions.create({ title: 'Chat' }).id)

    await ask(fixture, sessionId, '@hello-kit 帮我打个招呼')
    await ask(fixture, sessionId, '再来一次，不带插件')

    const [withPlugin, without] = captured
    const references = injected(withPlugin!)
    expect(references).toHaveLength(1)
    const text = messageText(references[0]!)
    expect(text).toContain('<plugin_reference id="hello-kit" status="enabled">')
    expect(text).toContain('<plugin_name>"hello-kit"</plugin_name>')
    expect(text).toContain('- skill "hello": available')
    expect(text).toContain('HELLO-BODY')
    // After the user's message (and the step's other context), and the
    // system prompt is the same.
    const at = withPlugin!.messages.indexOf(references[0]!)
    const users = withPlugin!.messages
      .slice(0, at)
      .filter((message) => message.source.kind === 'user')
    expect(messageText(users[users.length - 1]!)).toContain('@hello-kit')
    expect(withPlugin!.system).toBe(without!.system)
    expect(injected(without!)).toEqual([])
  })

  it('says GitHub is not logged in, and says so for a plugin that is off or missing', async () => {
    const captured: GenerateOptions[] = []
    const fixture = await api(captured)
    await installHello(fixture)
    await fixture.api.plugins.setEnabled({
      pluginId: 'hello-kit',
      scope: 'user',
      enabled: false,
    })
    const sessionId = String(fixture.api.sessions.create({ title: 'Chat' }).id)

    // Chips always stand after whitespace, as the gesture requires.
    await ask(
      fixture,
      sessionId,
      '@github 看看我的 PR， @hello-kit 和 @no-such-kit 也用上',
    )
    const texts = injected(captured[0]!).map((message) => messageText(message))
    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain(
      '<plugin_reference id="github" status="enabled">',
    )
    expect(texts[0]).toContain(
      '- app "github": unavailable: "在终端运行 gh auth login 登录 GitHub"',
    )
    expect(texts[0]).toContain('<skill_content name="github">')
    expect(texts[1]).toMatch(
      /status="disabled">The "hello-kit" plugin is turned off/,
    )
    expect(texts[2]).toMatch(
      /status="missing">No plugin "no-such-kit" is installed/,
    )
  })

  it('brings the computer-use Skill with Computer Use, or says it is off', async () => {
    const captured: GenerateOptions[] = []
    const fixture = await api(captured, {
      computerUsePort: new FakeComputerUsePort(),
    })
    const sessionId = String(fixture.api.sessions.create({ title: 'GUI' }).id)

    await ask(fixture, sessionId, '@computer-use 打开示例网页')
    expect(messageText(injected(captured[0]!)[0]!)).toMatch(
      /status="disabled">.*电脑操作未开启（设置 › 电脑操作）/,
    )

    await fixture.api.computerUse.setEnabled(true)
    await ask(fixture, sessionId, '@computer-use 打开示例网页')
    const text = messageText(injected(captured[1]!)[0]!)
    expect(text).toContain(
      '<plugin_reference id="computer-use" status="enabled">',
    )
    expect(text).toContain('<skill_content name="computer-use">')
    expect(text).toContain('- app "embedded-browser": connected')
  })
})
