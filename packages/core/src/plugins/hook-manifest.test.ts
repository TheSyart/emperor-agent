import { describe, expect, it } from 'vitest'
import { parsePluginHooks, type PluginHookDialect } from './hook-manifest'

function parse(
  hooks: Record<string, unknown>,
  dialect: PluginHookDialect = 'codex',
  mcpServers: string[] = [],
) {
  return parsePluginHooks(
    {
      raw: { hooks },
      label: 'hooks/hooks.json',
      sourcePath: '/pkg/hooks/hooks.json',
    },
    { dialect, mcpServers, counts: new Map() },
  )
}

function one(event: string, matcher: string | undefined, handler: object = {}) {
  const parsed = parse(
    {
      [event]: [
        {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: [{ type: 'command', command: 'run.sh', ...handler }],
        },
      ],
    },
    'codex',
    ['files', 'files_v2'],
  )
  return { spec: parsed.hooks[0]!, component: parsed.components[0]! }
}

describe('Codex hook translation', () => {
  it.each([
    ['^Bash$', ['bash']],
    ['Bash', ['bash']],
    ['^(Bash|apply_patch)$', ['bash', 'edit', 'write']],
    ['Write|Edit', ['edit', 'write']],
    ['MultiEdit', ['edit']],
    ['Read|Glob|Grep', ['read', 'glob', 'grep']],
    ['WebSearch|web_search', ['web_search']],
    ['update_plan|TodoWrite', ['todo_write']],
    ['Agent|spawn_agent|Task', ['subagent', 'subagent_fork']],
  ])('maps the tool matcher %s', (matcher, subjects) => {
    const { spec, component } = one('PreToolUse', matcher)
    expect(spec.mapped).toEqual({ event: 'PreToolUse', subjects })
    expect(component).toMatchObject({ state: 'available', reason: null })
  })

  it('matches every tool for an empty, star or missing matcher', () => {
    for (const matcher of ['', '*', undefined])
      expect(one('PostToolUse', matcher).spec.mapped).toEqual({
        event: 'PostToolUse',
      })
  })

  it("names this package's MCP tools and leaves the rest unsupported", () => {
    expect(one('PreToolUse', '^mcp__files_v2__read_file$').spec.mapped).toEqual(
      {
        event: 'PreToolUse',
        subjects: [],
        mcpTools: [{ server: 'files_v2', tool: 'read_file' }],
      },
    )
    expect(one('PreToolUse', 'Bash|mcp__files__list').spec.mapped).toEqual({
      event: 'PreToolUse',
      subjects: ['bash'],
      mcpTools: [{ server: 'files', tool: 'list' }],
    })
    expect(one('PreToolUse', 'mcp__github__search').component).toMatchObject({
      state: 'unsupported',
      reason: expect.stringContaining('不是本插件的 MCP 工具'),
    })
  })

  it.each([
    ['WebFetch', '没有与「WebFetch」对应的工具'],
    ['Bash|WebFetch', '没有与「WebFetch」对应的工具'],
    ['Bash.*', '不翻译一般正则'],
    ['mcp__.*', '不翻译一般正则'],
    ['^(?:Bash)$', '不翻译一般正则'],
  ])(
    'keeps %s unsupported instead of half-translating it',
    (matcher, reason) => {
      const { spec, component } = one('PreToolUse', matcher)
      expect(spec.mapped).toBeUndefined()
      expect(component.state).toBe('unsupported')
      expect(component.reason).toContain(reason)
    },
  )

  it('reads SessionStart sources, ignores prompt and stop matchers, and limits subagent matchers', () => {
    expect(one('SessionStart', 'startup|resume').spec.mapped).toEqual({
      event: 'SessionStart',
      subjects: ['startup', 'resume'],
    })
    expect(one('SessionStart', 'bogus').component.state).toBe('unsupported')
    expect(one('UserPromptSubmit', 'anything').spec).toMatchObject({
      matcher: null,
      mapped: { event: 'UserPromptSubmit' },
    })
    expect(one('Stop', undefined).spec.mapped).toEqual({ event: 'Stop' })
    expect(one('SubagentStart', '*').spec.mapped).toEqual({
      event: 'SubagentStart',
    })
    expect(one('SubagentStop', 'explorer').component.state).toBe('unsupported')
  })

  it('keeps events and handler types Emperor lacks unsupported', () => {
    for (const event of [
      'SessionEnd',
      'PermissionRequest',
      'PreCompact',
      'PostCompact',
      'Interrupt',
    ])
      expect(one(event, undefined).component).toMatchObject({
        state: 'unsupported',
        reason: expect.stringContaining(event),
      })
    expect(
      one('PreToolUse', 'Bash', { type: 'mcp_tool', server: 's', tool: 't' })
        .component.reason,
    ).toContain('mcp_tool')
    expect(
      one('PreToolUse', 'Bash', { async: true }).component.reason,
    ).toContain('async')
  })

  it('numbers handlers per event across groups and keeps the command as written', () => {
    const parsed = parse({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ command: 'a.sh' }, { command: 'b.sh', timeout: 5 }],
        },
        { matcher: 'Write', hooks: [{ command: '${PLUGIN_ROOT}/c.sh' }] },
      ],
      Stop: [{ hooks: [{ command: 'd.sh' }] }],
    })
    expect(parsed.hooks.map((hook) => hook.id)).toEqual([
      'PreToolUse#1',
      'PreToolUse#2',
      'PreToolUse#3',
      'Stop#1',
    ])
    expect(parsed.hooks[1]).toMatchObject({ timeoutSec: 5 })
    expect(parsed.components[2]).toMatchObject({
      kind: 'hook',
      id: 'PreToolUse#3',
      title: 'PreToolUse · Write',
      description: '${PLUGIN_ROOT}/c.sh',
      sourcePath: '/pkg/hooks/hooks.json',
    })
    expect(parsed.components[3]!.title).toBe('Stop')
  })

  it('rejects files that are not hook documents', () => {
    const invalid = (raw: unknown) => {
      try {
        parsePluginHooks(
          { raw, label: 'hooks.json', sourcePath: '/pkg/hooks.json' },
          { dialect: 'codex', mcpServers: [], counts: new Map() },
        )
        return undefined
      } catch (error) {
        return (error as { code?: string }).code
      }
    }
    expect(invalid([])).toBe('plugin_preview_member_invalid')
    expect(invalid({ hooks: { PreToolUse: {} } })).toBe(
      'plugin_preview_member_invalid',
    )
    expect(invalid({ PreToolUse: [{ matcher: 1, hooks: [] }] })).toBe(
      'plugin_preview_member_invalid',
    )
    expect(invalid({ PreToolUse: [{ hooks: [{ type: 'command' }] }] })).toBe(
      'plugin_preview_member_invalid',
    )
    expect(
      invalid({ PreToolUse: [{ hooks: [{ command: 'x', timeout: 0 }] }] }),
    ).toBe('plugin_preview_member_invalid')
  })
})

describe('Emperor hook dialect', () => {
  it('keeps the matcher as written and checks it compiles', () => {
    const parsed = parse(
      {
        PreToolUse: [
          { matcher: 'bash|write', hooks: [{ command: 'guard.sh' }] },
        ],
        PostToolUse: [{ matcher: 'mcp_.*', hooks: [{ command: 'log.sh' }] }],
      },
      'emperor',
    )
    expect(parsed.hooks.map((hook) => hook.mapped)).toEqual([
      { event: 'PreToolUse', matcher: 'bash|write' },
      { event: 'PostToolUse', matcher: 'mcp_.*' },
    ])
    expect(() =>
      parse(
        { PreToolUse: [{ matcher: '(', hooks: [{ command: 'x' }] }] },
        'emperor',
      ),
    ).toThrow(/不是合法的正则/)
  })

  it('marks unknown events and non-command handlers unsupported', () => {
    const parsed = parse(
      {
        Notification: [{ hooks: [{ command: 'n.sh' }] }],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }],
      },
      'emperor',
    )
    expect(parsed.components.map((component) => component.state)).toEqual([
      'unsupported',
      'unsupported',
    ])
  })
})
