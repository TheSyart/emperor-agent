// REL-03 备份与恢复 (the Emperor Home side; main zips and unzips the
// folder): a backup restored into an empty home gives the same sessions,
// memory and settings (card test 6); a restore first moves the data it
// replaces to `migrations/backup-<ts>/` (card test 8); a backup cannot
// write outside what it is allowed to hold.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreApi } from '../api/core-api'
import { makeApi, tmp } from '../api/test-helpers'
import {
  BACKUP_MANIFEST,
  applyPendingRestore,
  pendingRestoreExists,
  planHomeBackup,
  readHomeBackup,
  scheduleHomeRestore,
  stageHomeBackup,
} from './backup'

const VIEW = { sessionId: null }
const NOW = () => new Date('2026-10-20T09:00:00.000Z')
const apis: CoreApi[] = []
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()))
})

async function open(home: string, replies = [] as { text: string }[]) {
  const fixture = await makeApi({
    root: dirname(home),
    stateRoot: home,
    replies,
  })
  apis.push(fixture.api)
  return fixture.api
}

async function closeAll(): Promise<void> {
  await Promise.all(apis.splice(0).map((api) => api.close()))
}

/** A home with a conversation, memory, settings, a model and an MCP server. */
async function populated(): Promise<{ home: string; sessionId: string }> {
  const home = join(tmp('emperor-rel03-backup-a-'), 'home')
  const api = await open(home, [{ text: 'REL03 restored reply' }])
  const sessionId = String(api.sessions.create({ title: 'REL03 kept' }).id)
  await api.chat.submit({ content: 'REL03 question', sessionId })
  await api.memory.save(
    '# Memory\n\n## Open Questions\n\nREL03 long-term note\n',
  )
  await api.browser.setPreferences({ showFullUrl: false }, VIEW)
  await api.model.saveEntry(
    {
      provider: 'openai',
      protocol: 'openai',
      modelId: 'gpt-5.2',
      displayName: 'REL03 model',
      apiKey: 'sk-rel03-backup',
      apiBase: 'https://api.openai.com/v1',
      maxTokens: 8192,
      reasoningEffort: 'high',
      contextWindowTokens: 128000,
    } as never,
    VIEW,
  )
  await api.mcp.saveConfig(
    { servers: { fs: { command: 'npx', enabled: false } } },
    VIEW,
  )
  await closeAll()
  // What a backup never takes: the local key, browser profiles, logs.
  mkdirSync(join(home, 'computer-use', 'secrets'), { recursive: true })
  writeFileSync(
    join(home, 'computer-use', 'secrets', 'local.key'),
    'A'.repeat(32),
  )
  writeFileSync(join(home, 'computer-use', 'vault.json'), '{"version":3}')
  mkdirSync(join(home, 'browser', 'profiles', 'p1'), { recursive: true })
  writeFileSync(join(home, 'browser', 'profiles', 'p1', 'Cookies'), 'cookie')
  mkdirSync(join(home, 'logs'), { recursive: true })
  writeFileSync(join(home, 'logs', 'main.log'), 'log line')
  return { home, sessionId }
}

function relativeFiles(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory()
      ? relativeFiles(join(root, entry.name), rel)
      : [rel]
  })
}

function logOf(home: string): Array<Record<string, unknown>> {
  const file = join(home, 'migrations', 'log.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}

async function stage(home: string, includeSessions = true): Promise<string> {
  const folder = join(mkdtempSync(join(tmpdir(), 'emperor-rel03-stage-')), 'b')
  await stageHomeBackup({
    home,
    folder,
    includeSessions,
    appVersion: '0.2.0',
    now: NOW,
  })
  return folder
}

describe('planHomeBackup', () => {
  it('lists what a backup holds, sessions as the optional part', async () => {
    const { home } = await populated()
    const plan = planHomeBackup(home)
    const ids = plan.categories.map((category) => category.id)
    expect(ids).toEqual([
      'config',
      'memory',
      'extensions',
      'projects',
      'sessions',
    ])
    expect(plan.categories.find((c) => c.id === 'sessions')).toMatchObject({
      optional: true,
    })
    for (const category of plan.categories)
      expect(category.files).toBeGreaterThanOrEqual(0)
    expect(
      plan.categories.find((c) => c.id === 'config')!.bytes,
    ).toBeGreaterThan(0)
    expect(plan.excluded.length).toBeGreaterThan(0)
  })
})

describe('stageHomeBackup', () => {
  it('copies the backup scope and leaves secrets, browser data and logs out', async () => {
    const { home } = await populated()
    const folder = await stage(home)
    const files = relativeFiles(folder)
    expect(files).toContain(BACKUP_MANIFEST)
    expect(files).toContain('home/settings.json')
    expect(files).toContain('home/model_config.json')
    expect(files.some((file) => file.startsWith('home/sessions/'))).toBe(true)
    for (const never of [
      'home/computer-use/secrets/local.key',
      'home/computer-use/vault.json',
      'home/browser/profiles/p1/Cookies',
      'home/logs/main.log',
      'home/installation.json',
    ])
      expect(files).not.toContain(never)
    expect(files.some((file) => file.includes('.lock'))).toBe(false)
    const manifest = JSON.parse(
      readFileSync(join(folder, BACKUP_MANIFEST), 'utf8'),
    )
    expect(manifest).toMatchObject({
      format: 'emperor-backup',
      version: 1,
      appVersion: '0.2.0',
      createdAt: '2026-10-20T09:00:00.000Z',
      dataVersion: 1,
      categories: ['config', 'memory', 'extensions', 'projects', 'sessions'],
      credentials: false,
    })
  })

  it('leaves conversations out when asked to', async () => {
    const { home } = await populated()
    const folder = await stage(home, false)
    const files = relativeFiles(folder)
    expect(files.some((file) => file.startsWith('home/sessions/'))).toBe(false)
    expect(readHomeBackup(folder).manifest.categories).not.toContain('sessions')
  })
})

describe('restore', () => {
  it('into an empty home gives the same sessions, memory and settings (6)', async () => {
    const { home, sessionId } = await populated()
    const source = await open(home)
    const before = {
      sessions: source.sessions
        .list()
        .map((s) => ({ id: s.id, title: s.title })),
      history: source.sessions.history({ sessionId }).events.length,
      memory: (await source.memory.get(VIEW)).long_term,
      browser: await source.browser.preferences(),
      models: (await source.model.getConfig()).models.map(
        (entry: { displayName?: string }) => entry.displayName,
      ),
      mcp: Object.keys((await source.mcp.getConfig()).servers ?? {}),
    }
    await closeAll()
    const folder = await stage(home)

    const target = join(tmp('emperor-rel03-backup-b-'), 'home')
    mkdirSync(target, { recursive: true })
    scheduleHomeRestore({ home: target, folder })
    expect(pendingRestoreExists(target)).toBe(true)
    const result = applyPendingRestore({ home: target, now: NOW })
    expect(result).toMatchObject({ status: 'applied' })
    expect(pendingRestoreExists(target)).toBe(false)

    const restored = await open(target)
    expect(
      restored.sessions.list().map((s) => ({ id: s.id, title: s.title })),
    ).toEqual(before.sessions)
    expect(restored.sessions.history({ sessionId }).events.length).toBe(
      before.history,
    )
    expect((await restored.memory.get(VIEW)).long_term).toBe(before.memory)
    expect(await restored.browser.preferences()).toEqual(before.browser)
    expect(
      (await restored.model.getConfig()).models.map(
        (entry: { displayName?: string }) => entry.displayName,
      ),
    ).toEqual(before.models)
    expect(Object.keys((await restored.mcp.getConfig()).servers ?? {})).toEqual(
      before.mcp,
    )
    // The local key was never in the backup.
    expect(
      existsSync(join(target, 'computer-use', 'secrets', 'local.key')),
    ).toBe(false)
  })

  it('first moves the data it replaces to migrations/backup-<ts> (8)', async () => {
    const { home: source } = await populated()
    const folder = await stage(source)

    const current = join(tmp('emperor-rel03-backup-c-'), 'home')
    const api = await open(current)
    const own = String(
      api.sessions.create({ title: 'only in the current home' }).id,
    )
    api.sessions.list()
    await api.memory.save(
      '# Memory\n\n## Open Questions\n\ncurrent home note\n',
    )
    await api.browser.setPreferences({ history: false }, VIEW)
    await closeAll()
    mkdirSync(join(current, 'computer-use', 'secrets'), { recursive: true })
    writeFileSync(
      join(current, 'computer-use', 'secrets', 'local.key'),
      'B'.repeat(32),
    )
    mkdirSync(join(current, 'browser', 'profiles', 'mine'), { recursive: true })
    const currentSettings = readFileSync(join(current, 'settings.json'), 'utf8')
    const currentMemory = readFileSync(
      join(current, 'memory', 'MEMORY.local.md'),
      'utf8',
    )

    scheduleHomeRestore({ home: current, folder })
    const result = applyPendingRestore({ home: current, now: NOW })
    expect(result?.status).toBe('applied')
    const backup = String(result?.backup)
    expect(backup).toMatch(/^migrations\/backup-2026-10-20T09-00-00/)

    // What was there before the restore, kept as it was.
    expect(readFileSync(join(current, backup, 'settings.json'), 'utf8')).toBe(
      currentSettings,
    )
    expect(
      readFileSync(join(current, backup, 'memory', 'MEMORY.local.md'), 'utf8'),
    ).toBe(currentMemory)
    expect(
      relativeFiles(join(current, backup, 'sessions')).some((file) =>
        file.includes(own),
      ),
    ).toBe(true)
    // The restored data in its place; what a backup never holds untouched.
    expect(
      readFileSync(join(current, 'memory', 'MEMORY.local.md'), 'utf8'),
    ).toContain('REL03 long-term note')
    expect(
      readFileSync(
        join(current, 'computer-use', 'secrets', 'local.key'),
        'utf8',
      ),
    ).toBe('B'.repeat(32))
    expect(existsSync(join(current, 'browser', 'profiles', 'mine'))).toBe(true)

    expect(logOf(current)).toContainEqual(
      expect.objectContaining({
        kind: 'restore',
        status: 'applied',
        backup,
        backupCreatedAt: '2026-10-20T09:00:00.000Z',
        categories: ['config', 'memory', 'extensions', 'projects', 'sessions'],
      }),
    )
  })

  it('keeps the current conversations when the backup has none', async () => {
    const { home: source } = await populated()
    const folder = await stage(source, false)
    const current = join(tmp('emperor-rel03-backup-d-'), 'home')
    const api = await open(current)
    const own = String(api.sessions.create({ title: 'stays' }).id)
    api.sessions.list()
    await closeAll()
    scheduleHomeRestore({ home: current, folder })
    applyPendingRestore({ home: current, now: NOW })
    const reopened = await open(current)
    expect(reopened.sessions.list().map((s) => s.id)).toContain(own)
  })

  it('puts everything back when the restore fails halfway', async () => {
    const { home: source } = await populated()
    const folder = await stage(source)
    const current = join(tmp('emperor-rel03-backup-e-'), 'home')
    await open(current)
    await closeAll()
    const settings = readFileSync(join(current, 'settings.json'), 'utf8')
    scheduleHomeRestore({ home: current, folder })
    let moves = 0
    const result = applyPendingRestore({
      home: current,
      now: NOW,
      // Fail on the fourth move, after some units already moved.
      beforeMove: () => {
        moves += 1
        if (moves === 4) throw new Error('disk full')
      },
    })
    expect(result).toMatchObject({ status: 'rolled_back', error: 'disk full' })
    expect(readFileSync(join(current, 'settings.json'), 'utf8')).toBe(settings)
    expect(pendingRestoreExists(current)).toBe(false)
    expect(logOf(current)).toContainEqual(
      expect.objectContaining({ kind: 'restore', status: 'rolled_back' }),
    )
  })
})

describe('readHomeBackup', () => {
  it('refuses a backup that reaches outside its scope or links elsewhere', async () => {
    const { home } = await populated()
    const outside = await stage(home)
    mkdirSync(join(outside, 'home', 'computer-use', 'secrets'), {
      recursive: true,
    })
    writeFileSync(
      join(outside, 'home', 'computer-use', 'secrets', 'local.key'),
      'x',
    )
    expect(() => readHomeBackup(outside)).toThrow(/备份/)

    const linked = await stage(home)
    symlinkSync('/etc/hosts', join(linked, 'home', 'memory', 'hosts'))
    expect(() => readHomeBackup(linked)).toThrow(/备份/)
  })

  it('refuses a backup from a newer Emperor', async () => {
    const { home } = await populated()
    const folder = await stage(home)
    const path = join(folder, BACKUP_MANIFEST)
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version: 2 }),
    )
    expect(() => readHomeBackup(folder)).toThrow(
      '这个备份来自更新版本的 Emperor',
    )
  })
})
