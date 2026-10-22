// How home/ was written: Emperor 0.1.0-preview.4's own Core, the way the
// preview.4 desktop app used it (bootstrapEmperorHome with the default
// source, then CoreApi), a model added through saveModelEntry, a long-term
// memory line, the profile interview skipped, and two chat sessions answered
// by a scripted model (no network, no real model). Absolute paths become
// tokens (see fixture.json) so the home can be copied anywhere.
//
//   src=$(mktemp -d)
//   git archive v0.1.0-preview.4 packages/core templates skills config package.json | tar -x -C "$src"
//   ln -s "$PWD/node_modules" "$src/node_modules"
//   HOME=$(mktemp -d) node_modules/.bin/vite-node \
//     packages/core/fixtures/emperor-home-0.1.0-preview.4/generate.ts -- "$src"
//
// Session ids are random: copy the printed ids into fixture.json, and the
// printed modes into its `modes` (git keeps only 100644 / 100755, so the
// checkout cannot carry the 0600 preview.4 gave its secret files).
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [p4src] = process.argv.slice(2).filter((arg) => arg !== '--')
if (!p4src) throw new Error('usage: generate.ts -- <preview.4 source tree>')
// Real paths: Core records them, and macOS's tmpdir() is a symlink.
const source = realpathSync(resolve(p4src))
const core = join(source, 'packages', 'core', 'src')
const out = join(dirname(fileURLToPath(import.meta.url)), 'home')
const home = join(
  realpathSync(mkdtempSync(join(tmpdir(), 'emperor-preview4-'))),
  'home',
)

const { bootstrapEmperorHome } = await import(
  join(core, 'runtime', 'installation.ts')
)
const { makeApi } = await import(join(core, 'api', 'test-helpers.ts'))
const { saveModelEntry, activateModelEntry } = await import(
  join(core, 'config', 'model-config.ts')
)

const APP_VERSION = '0.1.0-preview.4'
// Stands in for the packaged runtime-manifest digest a preview.4 install records.
const RUNTIME_REVISION = createHash('sha256')
  .update('emperor-0.1.0-preview.4-fixture')
  .digest('hex')
let tick = Date.parse('2026-10-14T09:00:00.000Z')
const now = () => new Date((tick += 1000)).toISOString()

mkdirSync(home, { recursive: true })
bootstrapEmperorHome({
  emperorHome: home,
  source: 'default',
  legacyHome: null,
  appVersion: APP_VERSION,
  runtimeRevision: RUNTIME_REVISION,
  now,
})

const { api, adapter } = await makeApi({
  root: source,
  stateRoot: home,
  replies: [
    {
      text: '你好！我是 Emperor。这条回复来自 0.1.0-preview.4 的升级测试夹具。',
    },
    { text: '记住了：升级后这段对话仍然可以打开。' },
    { text: '第二个会话的回复，同样写于 0.1.0-preview.4。' },
  ],
  extra: {
    appVersion: APP_VERSION,
    runtimeRevision: RUNTIME_REVISION,
    emperorHomePrepared: true,
    stateRootSource: 'default',
  },
})
adapter.titleText = '升级测试会话'

const saved = await saveModelEntry(home, {
  provider: 'deepseek',
  protocol: 'openai',
  modelId: 'deepseek-chat',
  displayName: 'DeepSeek（夹具）',
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: 'fixture-placeholder-not-a-real-key',
  contextWindowTokens: 128000,
  maxTokens: 8192,
  reasoningEffort: null,
})
await activateModelEntry(
  home,
  saved.raw.models.find(
    (entry: { modelId: string }) => entry.modelId === 'deepseek-chat',
  )?.entryId,
)

api.memory.save(
  '# 长期记忆\n\n## Long-Term Projects\n\n- 升级测试夹具：验证 0.1.0-preview.4 的数据升级后仍可读。\n',
)
// A preview.4 user who chatted had answered or skipped the profile interview.
await api.onboarding.skipProfileInterview()

const first = String(api.sessions.create({ title: '升级测试会话' }).id)
await api.chat.submit({ content: '你好，Emperor', sessionId: first })
await api.chat.submit({
  content: '请记住：这段对话写于 0.1.0-preview.4',
  sessionId: first,
})
const second = String(api.sessions.create({ title: '第二个会话' }).id)
await api.chat.submit({ content: '第二个会话的提问', sessionId: second })
await api.close()

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
rmSync(out, { recursive: true, force: true })
const modes: Record<string, string> = {}
for (const file of walk(home)) {
  modes[relative(home, file)] = (statSync(file).mode & 0o777).toString(8)
  const target = join(out, relative(home, file))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    readFileSync(file, 'utf8')
      .split(home)
      .join('__EMPEROR_HOME__')
      .split(source)
      .join('__PREVIEW4_RUNTIME__'),
  )
  chmodSync(target, statSync(file).mode & 0o777)
}
const sorted = Object.fromEntries(
  Object.entries(modes).sort(([a], [b]) => (a < b ? -1 : 1)),
)
console.log(JSON.stringify({ first, second, out, modes: sorted }, null, 2))
