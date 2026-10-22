import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCoreHost } from './core-host'
import { QUIET_TOOLCHAIN } from './test-fixtures/test-core'
import {
  DiagnosticsBundles,
  sanitizeCoreDiagnostics,
  sanitizeModelConfig,
  type DiagnosticsBundleSources,
} from './diagnostics-bundle'

const roots: string[] = []
function temp(prefix = 'emperor-bundle-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const NOW = new Date('2026-10-20T08:30:00.000Z')

function sources(
  home: string,
  overrides: Partial<DiagnosticsBundleSources> = {},
): DiagnosticsBundleSources {
  return {
    logDir: join(home, 'Library', 'Logs', 'Emperor Agent'),
    crashDumps: join(home, 'Library', 'Logs', 'Emperor Agent', 'Crashpad'),
    stateRoot: join(home, '.emperor'),
    homeDir: home,
    app: async () => ({
      app: { name: 'Emperor Agent', version: '0.2.0', packaged: false },
      versions: { electron: '42.4.1', node: '22.20.0' },
      fuses: { RunAsNode: true },
      helper: { available: false, reason: 'development build' },
      extension: null,
    }),
    core: () => Promise.resolve({ root: join(home, 'app'), paths: {} }),
    system: () => ({ platform: 'darwin', release: '25.4.0', arch: 'arm64' }),
    ...overrides,
  }
}

function seedLogs(dir: string, extra = ''): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'main.log'),
    `2026-10-20T08:00:00.000Z [info] Emperor Agent starting\n${extra}`,
  )
  writeFileSync(
    join(dir, 'main.log.1'),
    '2026-10-19T08:00:00.000Z [info] older\n',
  )
  writeFileSync(
    join(dir, 'core.log'),
    '2026-10-20T08:00:01.000Z [warn] scheduler tick failed\n',
  )
}

/** `unzip -Z1`: the zip's file entries, without the bundle folder. */
function zipEntries(zip: string, folder: string): string[] {
  return execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.endsWith('/'))
    .map((line) => line.slice(folder.length + 1))
    .sort()
}

function extract(zip: string): string {
  const out = temp('emperor-bundle-out-')
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out])
  return out
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

describe('diagnostics bundle (REL-01)', () => {
  it('test 7: the contents list matches the zip, file by file and byte by byte', async () => {
    const home = temp()
    const src = sources(home)
    seedLogs(src.logDir)
    mkdirSync(src.stateRoot, { recursive: true })
    writeFileSync(
      join(src.stateRoot, 'model_config.json'),
      JSON.stringify({ schemaVersion: 2, models: [] }),
    )
    const bundles = new DiagnosticsBundles({
      sources: src,
      tempDir: temp('emperor-bundle-stage-'),
      now: () => NOW,
    })
    const view = await bundles.prepare()
    expect(view.name).toMatch(/^emperor-diagnostics-\d{8}-\d{6}$/)
    expect(view.entries.map((entry) => entry.path).sort()).toEqual([
      'README.txt',
      'app.json',
      'crashes.json',
      'diagnostics.json',
      'logs/core.log',
      'logs/main.log',
      'logs/main.log.1',
      'model-config.json',
      'system.json',
    ])
    for (const entry of view.entries) {
      expect(entry.title).not.toBe('')
      expect(entry.bytes).toBeGreaterThan(0)
    }
    expect(view.excluded).toEqual([
      '会话与消息内容',
      '记忆',
      'API Key、令牌等密钥',
      '崩溃转储文件本身（只列出文件名）',
    ])

    const target = join(temp('emperor-bundle-target-'), `${view.name}.zip`)
    const result = await bundles.export(view.id, target)
    expect(result).toEqual({
      name: `${view.name}.zip`,
      path: target,
      entries: view.entries,
    })
    expect(zipEntries(target, view.name)).toEqual(
      view.entries.map((entry) => entry.path).sort(),
    )
    const out = join(extract(target), view.name)
    for (const entry of view.entries)
      expect(statSync(join(out, entry.path)).size).toBe(entry.bytes)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    // The README lists the same files.
    const readme = readFileSync(join(out, 'README.txt'), 'utf8')
    for (const entry of view.entries) expect(readme).toContain(entry.path)
    expect(readme).toContain('不包含')
  })

  it('test 8: no API key and no conversation text in the bundle (scan)', async () => {
    const KEY = 'sk-rel01-scan-4f7a9c2e1b'
    const MCP_TOKEN = 'tok-rel01-mcp-77aa'
    const TITLE = 'marker-title-93c1'
    const BODY = 'marker-body-5d2e'
    const MEMORY = 'marker-memory-0b6f'
    const root = temp('emperor-bundle-scan-')
    const home = join(root, 'home')
    mkdirSync(join(home, 'memory'), { recursive: true })
    writeFileSync(
      join(home, 'model_config.json'),
      JSON.stringify({
        schemaVersion: 2,
        activeModelId: 'fake-scan',
        models: [
          {
            entryId: 'fake-scan',
            provider: 'custom',
            protocol: 'openai',
            modelId: 'fake-scan-model',
            displayName: 'Fake Scan',
            apiBase: `https://llm.example.com/v1?key=${KEY}`,
            apiKey: KEY,
            contextWindowTokens: 128000,
            maxTokens: 4096,
          },
        ],
      }),
    )
    writeFileSync(
      join(home, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          scan: {
            command: 'node',
            args: ['x.js'],
            env: { API_TOKEN: MCP_TOKEN },
          },
        },
      }),
    )
    writeFileSync(join(home, 'memory', 'MEMORY.md'), `# 记忆\n${MEMORY}\n`)
    const logDir = join(root, 'logs')
    seedLogs(
      logDir,
      [
        `2026-10-20T08:00:02.000Z [error] request failed Authorization: Bearer ${KEY}`,
        `2026-10-20T08:00:03.000Z [warn] GET https://llm.example.com/v1/models?key=${KEY}`,
        `2026-10-20T08:00:04.000Z [info] saved {"apiKey":"${KEY}","env":{"API_TOKEN":"${MCP_TOKEN}"}}`,
        '',
      ].join('\n'),
    )
    const core = await createCoreHost({
      root,
      ipcMain: { handle: () => undefined },
      coreOptions: {
        stateRoot: home,
        stateRootSource: 'explicit',
        emperorHomePrepared: false,
        initializeMcp: false,
        environmentProbeRunner: QUIET_TOOLCHAIN,
        logDirectory: logDir,
      },
    })
    try {
      const session = core.sessions.create({ title: `计划 ${TITLE}` })
      core.host.agentFor(String(session.id)).session.append('todo/write', {
        todos: [{ content: `先做 ${BODY}`, status: 'pending' }],
      })
      const bundles = new DiagnosticsBundles({
        sources: {
          logDir,
          crashDumps: join(logDir, 'Crashpad'),
          stateRoot: home,
          homeDir: root,
          app: async () => ({ app: { version: '0.2.0' } }),
          core: () => core.diagnostics.get({ sessionId: null }),
          system: () => ({ platform: 'darwin' }),
        },
        tempDir: temp('emperor-bundle-stage-'),
        now: () => NOW,
      })
      const view = await bundles.prepare()
      const target = join(temp('emperor-bundle-target-'), 'scan.zip')
      await bundles.export(view.id, target)
      const out = extract(target)
      const files = filesUnder(out)
      expect(files.length).toBe(view.entries.length)
      const leaks: string[] = []
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        for (const needle of [
          KEY,
          '4f7a9c2e1b',
          MCP_TOKEN,
          TITLE,
          BODY,
          MEMORY,
        ])
          if (text.includes(needle))
            leaks.push(`${relative(out, file)}: ${needle}`)
      }
      expect(leaks).toEqual([])
      // Not an empty bundle: the real diagnostics and the model structure.
      const folder = join(out, view.name)
      const diagnostics = JSON.parse(
        readFileSync(join(folder, 'diagnostics.json'), 'utf8'),
      ) as { available: boolean; payload: { paths: { logsRoot: string } } }
      expect(diagnostics.available).toBe(true)
      expect(diagnostics.payload.paths.logsRoot).toBe('~/logs')
      const model = readFileSync(join(folder, 'model-config.json'), 'utf8')
      expect(model).toContain('fake-scan-model')
      expect(model).toContain('"apiKey": "[已移除]"')
      expect(readFileSync(join(folder, 'logs', 'main.log'), 'utf8')).toContain(
        'Authorization: ***',
      )
    } finally {
      await core.close()
    }
  })

  it('lists crash dumps by name and never packs them', async () => {
    const home = temp()
    const src = sources(home)
    seedLogs(src.logDir)
    mkdirSync(join(src.crashDumps, 'completed'), { recursive: true })
    writeFileSync(
      join(src.crashDumps, 'completed', '5b1c-crash.dmp'),
      'MDMP memory-marker-1c9e',
    )
    const bundles = new DiagnosticsBundles({
      sources: src,
      tempDir: temp(),
      now: () => NOW,
    })
    const view = await bundles.prepare()
    expect(view.entries.some((entry) => entry.path.endsWith('.dmp'))).toBe(
      false,
    )
    const target = join(temp(), 'x.zip')
    await bundles.export(view.id, target)
    const folder = join(extract(target), view.name)
    const crashes = JSON.parse(
      readFileSync(join(folder, 'crashes.json'), 'utf8'),
    ) as { directory: string; reports: Array<{ name: string; bytes: number }> }
    expect(crashes.directory).toBe('~/Library/Logs/Emperor Agent/Crashpad')
    expect(crashes.reports).toEqual([
      expect.objectContaining({ name: 'completed/5b1c-crash.dmp', bytes: 23 }),
    ])
    for (const file of filesUnder(folder))
      expect(readFileSync(file, 'utf8')).not.toContain('memory-marker-1c9e')
  })

  it('still builds a bundle while Core is not running (the recovery page)', async () => {
    const home = temp()
    const src = sources(home, { core: () => null })
    seedLogs(src.logDir)
    const bundles = new DiagnosticsBundles({
      sources: src,
      tempDir: temp(),
      now: () => NOW,
    })
    const view = await bundles.prepare()
    const target = join(temp(), 'x.zip')
    await bundles.export(view.id, target)
    const folder = join(extract(target), view.name)
    expect(
      JSON.parse(readFileSync(join(folder, 'diagnostics.json'), 'utf8')),
    ).toEqual({ available: false, reason: 'Core 没有启动，无法读取诊断' })
    expect(
      JSON.parse(readFileSync(join(folder, 'model-config.json'), 'utf8')),
    ).toEqual({ exists: false })
  })

  it('keeps only the newest part of a long log, marked as cut', async () => {
    const home = temp()
    const src = sources(home)
    mkdirSync(src.logDir, { recursive: true })
    writeFileSync(
      join(src.logDir, 'main.log'),
      `${'old line\n'.repeat(2000)}newest line\n`,
    )
    const bundles = new DiagnosticsBundles({
      sources: src,
      tempDir: temp(),
      now: () => NOW,
      logTailBytes: 1024,
    })
    const view = await bundles.prepare()
    const main = view.entries.find((entry) => entry.path === 'logs/main.log')!
    expect(main.bytes).toBeLessThan(1200)
    const target = join(temp(), 'x.zip')
    await bundles.export(view.id, target)
    const text = readFileSync(
      join(extract(target), view.name, 'logs', 'main.log'),
      'utf8',
    )
    expect(text.startsWith('（前面省略 ')).toBe(true)
    expect(text.endsWith('newest line\n')).toBe(true)
  })

  it('throws away a bundle that was not exported, and refuses unknown ids', async () => {
    const home = temp()
    const stage = temp()
    const bundles = new DiagnosticsBundles({
      sources: sources(home),
      tempDir: stage,
      now: () => NOW,
    })
    const view = await bundles.prepare()
    expect(readdirSync(stage)).toHaveLength(1)
    bundles.discard(view.id)
    expect(readdirSync(stage)).toHaveLength(0)
    await expect(bundles.export(view.id, join(home, 'x.zip'))).rejects.toThrow(
      '诊断包已过期，请重新导出',
    )
    expect(existsSync(join(home, 'x.zip'))).toBe(false)
    await expect(
      bundles.export('../../etc', join(home, 'y.zip')),
    ).rejects.toThrow()
  })

  it('remembers where a bundle went, for 在访达中显示', async () => {
    const home = temp()
    const bundles = new DiagnosticsBundles({
      sources: sources(home),
      tempDir: temp(),
      now: () => NOW,
    })
    const view = await bundles.prepare()
    expect(bundles.exportedPath(view.id)).toBeNull()
    const target = join(temp(), 'named')
    const result = await bundles.export(view.id, target)
    expect(result.path).toBe(`${target}.zip`)
    expect(bundles.exportedPath(view.id)).toBe(`${target}.zip`)
  })
})

describe('what the bundle keeps of the model config and Core diagnostics', () => {
  it('keeps the model config structure without any key', () => {
    expect(
      sanitizeModelConfig(
        {
          schemaVersion: 2,
          models: [
            {
              entryId: 'a',
              modelId: 'deepseek-v4',
              apiKey: 'el1:sealed-value',
              apiBase: 'https://user:pw@api.example.com/v1?token=abc',
              headers: { 'X-Api-Key': 'abc' },
              maxTokens: 4096,
            },
            { entryId: 'b', apiKey: '' },
          ],
        },
        '/Users/me',
      ),
    ).toEqual({
      schemaVersion: 2,
      models: [
        {
          entryId: 'a',
          modelId: 'deepseek-v4',
          apiKey: '[已移除]',
          apiBase: 'https://***@api.example.com/v1?token=***',
          headers: '[已移除]',
          maxTokens: 4096,
        },
        { entryId: 'b', apiKey: '' },
      ],
    })
  })

  it('drops conversation text from Core diagnostics and shows home as ~', () => {
    expect(
      sanitizeCoreDiagnostics(
        {
          root: '/Users/me/app',
          subagents: [
            {
              id: 'c1',
              parentId: 's1',
              description: 'rewrite the secret plan',
              mode: 'spawn',
              depth: 1,
              createdAt: 1,
              status: 'running',
            },
          ],
          activeTasks: [{ id: 't1', kind: 'turn', label: '帮我写周报' }],
          effectiveConfig: {
            entries: [{ key: 'mcp.config', status: 'applied' }],
            mcp: { env: { TOKEN: 'x' }, accessToken: 'y' },
          },
          runtime: { events: 3, maxTokens: 4096 },
        },
        '/Users/me',
      ),
    ).toEqual({
      root: '~/app',
      subagents: [
        {
          id: 'c1',
          parentId: 's1',
          mode: 'spawn',
          depth: 1,
          createdAt: 1,
          status: 'running',
        },
      ],
      activeTasks: [{ id: 't1', kind: 'turn' }],
      effectiveConfig: {
        // A config key's name stays; only values that are secrets go.
        entries: [{ key: 'mcp.config', status: 'applied' }],
        mcp: { env: '[已移除]', accessToken: '[已移除]' },
      },
      runtime: { events: 3, maxTokens: 4096 },
    })
  })
})
