import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodePersistenceAdapter } from '../store/persistence'
import { HookAuditStore } from './audit'
import { HookConfigLoader } from './config'
import { aggregateHookResults } from './decision'
import { executeHook } from './executor'
import { buildHookInput, findMatchingHooks } from './matcher'
import { parseHooksConfig } from './schema'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('hooks schema, audit, and matching', () => {
  it('normalizes command and http hooks while reporting invalid entries', () => {
    const parsed = parseHooksConfig({
      version: 1,
      enabled: true,
      projectHooks: { enabled: true },
      hooks: {
        PreToolUse: [
          {
            id: 'block-writes',
            matcher: 'write_file|edit_file',
            if: 'Tool(write_*)',
            handler: {
              type: 'command',
              command: 'node',
              args: ['hook.js'],
              timeoutMs: 50,
              allowedEnv: ['PATH'],
            },
          },
          { id: 'bad-handler', handler: { type: 'mcp', server: 'x' } },
        ],
        Stop: [
          {
            handler: {
              type: 'http',
              url: 'https://example.test/hook',
              headers: { 'x-hook': '1' },
            },
          },
        ],
        NotARealEvent: [
          { id: 'skip', handler: { type: 'command', command: 'true' } },
        ],
      },
    })

    expect(parsed.config.enabled).toBe(true)
    expect(parsed.config.projectHooks.enabled).toBe(true)
    expect(parsed.config.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.config.hooks.Stop).toHaveLength(1)
    expect(parsed.config.hooks.PreToolUse?.[0]).toMatchObject({
      id: 'block-writes',
      eventName: 'PreToolUse',
      matcher: 'write_file|edit_file',
      condition: 'Tool(write_*)',
      handler: {
        type: 'command',
        command: 'node',
        args: ['hook.js'],
        timeoutMs: 50,
        async: false,
      },
      enabled: true,
    })
    expect(parsed.diagnostics.map((d) => d.code)).toEqual([
      'invalid_handler',
      'invalid_event',
    ])
  })

  it('preserves corrupt audit lines while replaying newest bounded records', async () => {
    const root = tmp('emperor-hooks-audit-')
    const store = new HookAuditStore(root)
    await store.append({
      id: 'audit-1',
      hookId: 'h1',
      eventName: 'PreToolUse',
      handlerType: 'command',
      source: {
        kind: 'global',
        path: join(root, 'hooks_config.json'),
        readonly: false,
      },
      startedAt: '2026-07-07T00:00:00.000Z',
      durationMs: 3,
      status: 'completed',
      decision: 'allow',
      reason: 'ok',
    })
    writeFileSync(store.auditPath, 'not-json\n', { flag: 'a' })
    await store.append({
      id: 'audit-2',
      hookId: 'h2',
      eventName: 'Stop',
      handlerType: 'http',
      source: {
        kind: 'project',
        path: join(root, '.emperor/settings.json'),
        readonly: true,
      },
      startedAt: '2026-07-07T00:00:01.000Z',
      durationMs: 4,
      status: 'failed',
      decision: 'passthrough',
      reason: 'boom',
    })

    const replay = await store.replay({ limit: 1 })

    expect(replay.records.map((r) => r.id)).toEqual(['audit-2'])
    expect(replay.badLines).toEqual([{ line: 2, raw: 'not-json' }])
    expect(existsSync(store.auditPath)).toBe(true)
  })

  it('matches exact, wildcard, pipe, regex, tool conditions, and path glob conditions', () => {
    const parsed = parseHooksConfig({
      hooks: {
        PreToolUse: [
          {
            id: 'all',
            matcher: '*',
            handler: { type: 'command', command: 'true' },
          },
          {
            id: 'pipe',
            matcher: 'read_file|grep',
            handler: { type: 'command', command: 'true' },
          },
          {
            id: 'regex',
            matcher: '/^write_/',
            handler: { type: 'command', command: 'true' },
          },
          {
            id: 'tool-if',
            matcher: '*',
            if: 'Tool(write_*)',
            handler: { type: 'command', command: 'true' },
          },
          {
            id: 'path-if',
            matcher: '*',
            if: 'path:src/**/*.ts',
            handler: { type: 'command', command: 'true' },
          },
          {
            id: 'invalid-regex',
            matcher: '/(/',
            handler: { type: 'command', command: 'true' },
          },
        ],
      },
    })
    const input = buildHookInput('PreToolUse', {
      sessionId: 's1',
      cwd: '/repo',
      stateRoot: '/state',
      toolName: 'write_file',
      toolInput: { path: 'src/hooks/index.ts' },
    })

    const matches = findMatchingHooks(parsed.config, input)

    expect(matches.map((h) => h.id)).toEqual([
      'all',
      'regex',
      'tool-if',
      'path-if',
    ])
    expect(input).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/repo',
      state_root: '/state',
      tool_name: 'write_file',
    })
  })

  it('uses deterministic defaults for empty configs', () => {
    const parsed = parseHooksConfig(null)

    expect(parsed.config).toMatchObject({
      version: 1,
      enabled: true,
      projectHooks: { enabled: false },
      hooks: {},
    })
    expect(parsed.diagnostics).toEqual([])
    expect(readdirSync(tmp('emperor-hooks-empty-'))).toEqual([])
  })
})

describe('hooks config loading, execution, and decision aggregation', () => {
  it('loads editable global hooks and readonly project hooks only when trusted', async () => {
    const stateRoot = tmp('emperor-hooks-config-state-')
    const projectRoot = tmp('emperor-hooks-config-project-')
    mkdirSync(join(projectRoot, '.emperor'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'hooks_config.json'),
      JSON.stringify({
        projectHooks: { enabled: true },
        hooks: {
          PreToolUse: [
            {
              id: 'global-read',
              matcher: 'read_file',
              handler: { type: 'command', command: 'true' },
            },
          ],
        },
      }),
    )
    const projectHook = {
      id: 'project-write',
      matcher: 'write_file',
      handler: { type: 'command', command: 'true' },
    }
    writeFileSync(
      join(projectRoot, '.emperor/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [projectHook] } }),
    )
    writeFileSync(
      join(projectRoot, '.emperor/settings.local.json'),
      JSON.stringify({ hooks: { PreToolUse: [projectHook] } }),
    )

    const loaded = await new HookConfigLoader({ stateRoot }).load({
      projectRoot,
    })
    const hooks = loaded.config.hooks.PreToolUse ?? []

    expect(hooks.map((h) => h.id)).toEqual(['global-read', 'project-write'])
    expect(hooks[0]?.source).toMatchObject({ kind: 'global', readonly: false })
    expect(hooks[1]?.source).toMatchObject({ kind: 'project', readonly: true })
    expect(
      loaded.sources.map((s) => ({
        kind: s.kind,
        readonly: s.readonly,
        enabled: s.enabled,
      })),
    ).toEqual([
      { kind: 'global', readonly: false, enabled: true },
      { kind: 'project', readonly: true, enabled: true },
      { kind: 'project', readonly: true, enabled: true },
    ])

    writeFileSync(
      join(stateRoot, 'hooks_config.json'),
      JSON.stringify({ projectHooks: { enabled: false }, hooks: {} }),
    )
    const disabled = await new HookConfigLoader({ stateRoot }).load({
      projectRoot,
    })
    expect(disabled.config.hooks.PreToolUse ?? []).toEqual([])
  })

  it('preserves corrupt global config and reports malformed project hooks without writing project files', async () => {
    const stateRoot = tmp('emperor-hooks-corrupt-state-')
    const projectRoot = tmp('emperor-hooks-corrupt-project-')
    mkdirSync(join(projectRoot, '.emperor'), { recursive: true })
    writeFileSync(join(stateRoot, 'hooks_config.json'), '{bad')
    writeFileSync(
      join(projectRoot, '.emperor/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ handler: { type: 'mcp' } }] } }),
    )

    const loaded = await new HookConfigLoader({ stateRoot }).load({
      projectRoot,
    })

    expect(loaded.config.projectHooks.enabled).toBe(false)
    expect(
      readdirSync(stateRoot).some((name) =>
        name.startsWith('hooks_config.json.corrupt-'),
      ),
    ).toBe(true)
    expect(loaded.diagnostics.some((d) => d.code === 'corrupt_config')).toBe(
      true,
    )
    expect(
      readFileSyncText(join(projectRoot, '.emperor/settings.json')),
    ).toContain('"mcp"')
  })

  it('keeps the previous global hooks config when durable rename fails', async () => {
    const stateRoot = tmp('emperor-hooks-persistence-failure-')
    const healthy = new HookConfigLoader({ stateRoot })
    await healthy.saveGlobalConfig({ enabled: true, hooks: {} })
    const path = join(stateRoot, 'hooks_config.json')
    const before = readFileSync(path, 'utf8')

    const failing = new HookConfigLoader({
      stateRoot,
      persistenceAdapter: createNodePersistenceAdapter({
        beforeOperation(operation) {
          if (operation === 'rename') throw new Error('injected rename')
        },
      }),
    })
    await expect(
      failing.saveGlobalConfig({ enabled: false, hooks: {} }),
    ).rejects.toMatchObject({
      code: 'persistence_io',
      operation: 'rename',
    })

    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(
      readdirSync(stateRoot).filter((name) => name.includes('.tmp-')),
    ).toEqual([])
  })

  it('executes command hooks with stdin JSON, exit-code deny, timeout, and bounded output', async () => {
    const input = buildHookInput('PreToolUse', {
      sessionId: 's1',
      cwd: process.cwd(),
      stateRoot: '/state',
      toolName: 'write_file',
    })
    const jsonResult = await executeHook(
      {
        id: 'json',
        eventName: 'PreToolUse',
        enabled: true,
        matcher: '*',
        condition: '',
        source: null,
        handler: {
          type: 'command',
          command: process.execPath,
          args: [
            '-e',
            'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const i=JSON.parse(s);console.log(JSON.stringify({decision:"deny",reason:i.tool_name,additionalContext:"ctx"}))})',
          ],
          timeoutMs: 1_000,
          async: false,
          allowedEnv: ['PATH'],
        },
      },
      input,
    )

    expect(jsonResult).toMatchObject({
      status: 'completed',
      decision: 'deny',
      reason: 'write_file',
      additionalContext: 'ctx',
    })

    const exitDeny = await executeHook(
      {
        id: 'exit2',
        eventName: 'PreToolUse',
        enabled: true,
        matcher: '*',
        condition: '',
        source: null,
        handler: {
          type: 'command',
          command: process.execPath,
          args: ['-e', 'process.stderr.write("blocked");process.exit(2)'],
          timeoutMs: 1_000,
          async: false,
          allowedEnv: [],
        },
      },
      input,
    )
    expect(exitDeny).toMatchObject({
      status: 'failed',
      decision: 'deny',
      reason: 'blocked',
    })

    const timeout = await executeHook(
      {
        id: 'timeout',
        eventName: 'PreToolUse',
        enabled: true,
        matcher: '*',
        condition: '',
        source: null,
        handler: {
          type: 'command',
          command: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 5000)'],
          timeoutMs: 10,
          async: false,
          allowedEnv: [],
        },
      },
      input,
    )
    expect(timeout).toMatchObject({
      status: 'timeout',
      decision: 'passthrough',
    })
  })

  it('executes http hooks by posting hook input JSON', async () => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const input = JSON.parse(raw) as { hook_event_name: string }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ decision: 'allow', reason: input.hook_event_name }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('missing server address')
      const result = await executeHook(
        {
          id: 'http',
          eventName: 'Stop',
          enabled: true,
          matcher: '*',
          condition: '',
          source: null,
          handler: {
            type: 'http',
            url: `http://127.0.0.1:${address.port}/hook`,
            headers: { 'x-hook': '1' },
            timeoutMs: 1_000,
            async: false,
            allowedEnv: [],
          },
        },
        buildHookInput('Stop', {
          sessionId: 's1',
          cwd: process.cwd(),
          stateRoot: '/state',
        }),
      )

      expect(result).toMatchObject({
        status: 'completed',
        decision: 'allow',
        reason: 'Stop',
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('aggregates hook decisions with fixed priority and bounded context', () => {
    const decision = aggregateHookResults([
      {
        hookId: 'allow',
        status: 'completed',
        decision: 'allow',
        reason: 'ok',
        durationMs: 1,
        additionalContext: 'A',
      },
      {
        hookId: 'ask',
        status: 'completed',
        decision: 'ask',
        reason: 'check',
        durationMs: 1,
        additionalContext: 'B',
      },
      {
        hookId: 'deny',
        status: 'completed',
        decision: 'deny',
        reason: 'blocked',
        durationMs: 1,
        additionalContext: 'C',
      },
    ])

    expect(decision).toMatchObject({ decision: 'deny', reason: 'blocked' })
    expect(decision.additionalContext).toContain('[allow]')
    expect(decision.additionalContext).toContain('[ask]')
    expect(decision.additionalContext.length).toBeLessThanOrEqual(4_000)

    const update = aggregateHookResults([
      {
        hookId: 'update',
        status: 'completed',
        decision: 'allow',
        reason: '',
        durationMs: 1,
        updatedInput: { content: 'changed' },
      },
    ])
    expect(update.updatedInput).toEqual({ content: 'changed' })
  })
})

function readFileSyncText(path: string): string {
  return readFileSync(path, 'utf8')
}
