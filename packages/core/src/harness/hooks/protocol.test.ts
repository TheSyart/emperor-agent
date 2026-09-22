// Ports the essential dsh hook-protocol specs: matcher, codec, merge,
// stderr summary, detached runs, and the runner (real `sh -c` processes).
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHookOutput } from './codec'
import { createDetachedRuns } from './detached'
import { summarizeStderr } from './events'
import { matcherDiagnostic, matchesMatcher } from './matcher'
import { mergeHookOutputs } from './merge'
import { runHook, type RunHookOptions } from './runner'
import type { HookOutput } from './types'

describe('matchesMatcher', () => {
  it('treats absent / empty / * as match-all in both dialects', () => {
    for (const mode of ['claude-code', 'codex'] as const) {
      expect(matchesMatcher(undefined, 'Bash', mode)).toBe(true)
      expect(matchesMatcher('', 'anything', mode)).toBe(true)
      expect(matchesMatcher('*', 'whatever', mode)).toBe(true)
    }
  })

  it('claude: word patterns are literal exact matches and pipes are alternation', () => {
    expect(matchesMatcher('Bash', 'Bash', 'claude-code')).toBe(true)
    expect(matchesMatcher('Bash', 'BashOutput', 'claude-code')).toBe(false)
    expect(matchesMatcher('Edit|Write', 'Write', 'claude-code')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Read', 'claude-code')).toBe(false)
    expect(matchesMatcher('Edit|Write', 'EditFile', 'claude-code')).toBe(false)
  })

  it('claude: other patterns are unanchored regexes', () => {
    expect(matchesMatcher('^Bash$', 'Bash', 'claude-code')).toBe(true)
    expect(matchesMatcher('Bash.*', 'BashOutput', 'claude-code')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.js', 'claude-code')).toBe(false)
    expect(
      matchesMatcher('mcp__.*', 'mcp__github__search', 'claude-code'),
    ).toBe(true)
  })

  it('codex: every pattern is a regex (substring match)', () => {
    expect(matchesMatcher('Bash', 'BashOutput', 'codex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'BashOutput', 'codex')).toBe(false)
  })

  it('an invalid regex is a non-match and a parse-time diagnostic', () => {
    expect(matchesMatcher('(', 'x', 'claude-code')).toBe(false)
    expect(matcherDiagnostic('(', 'claude-code')).toBe(
      'invalid claude-code regex matcher "("',
    )
    expect(matcherDiagnostic('Edit|Write', 'claude-code')).toBeUndefined()
    expect(matcherDiagnostic('^Bash$', 'claude-code')).toBeUndefined()
  })
})

describe('parseHookOutput', () => {
  it('exit 0 without stdout is neutral; other non-zero exits are non-blocking', () => {
    expect(parseHookOutput(0, '', '').decision).toBeUndefined()
    const warn = parseHookOutput(1, '', 'some warning')
    expect(warn.decision).toBeUndefined()
    expect(warn.stderr).toBe('some warning')
    expect(
      parseHookOutput(undefined, '', 'spawn failed').decision,
    ).toBeUndefined()
  })

  it('exit 2 blocks with stderr as the reason, ignoring stdout JSON', () => {
    const out = parseHookOutput(
      2,
      JSON.stringify({ decision: 'approve' }),
      '  not allowed \n',
    )
    expect(out.decision).toBe('block')
    expect(out.reason).toBe('not allowed')
    expect(parseHookOutput(2, '', '  ').reason).toBeUndefined()
  })

  it('parses top-level continue/stopReason/systemMessage and legacy approve/block only', () => {
    const out = parseHookOutput(
      0,
      JSON.stringify({
        continue: false,
        stopReason: 'halt',
        systemMessage: 'hey',
        decision: 'block',
        reason: 'nope',
      }),
      '',
    )
    expect(out).toMatchObject({
      continue: false,
      stopReason: 'halt',
      systemMessage: 'hey',
      decision: 'block',
      reason: 'nope',
    })
    expect(
      parseHookOutput(0, JSON.stringify({ decision: 'deny' }), '').decision,
    ).toBeUndefined()
    expect(
      parseHookOutput(0, JSON.stringify({ decision: 'maybe' }), '').decision,
    ).toBeUndefined()
  })

  it('permissionDecision overrides the legacy decision and carries context / updatedInput', () => {
    const out = parseHookOutput(
      0,
      JSON.stringify({
        decision: 'approve',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'policy',
          additionalContext: 'ctx',
          updatedInput: { a: 1 },
        },
      }),
      '',
      'PreToolUse',
    )
    expect(out).toMatchObject({
      decision: 'deny',
      reason: 'policy',
      additionalContext: 'ctx',
      updatedInput: { a: 1 },
      hookEventName: 'PreToolUse',
    })
    expect(
      parseHookOutput(
        0,
        JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } }),
        '',
      ).decision,
    ).toBe('ask')
  })

  it('discards a hookSpecificOutput whose event name is missing or mismatched, keeping top-level fields', () => {
    const mismatched = parseHookOutput(
      0,
      JSON.stringify({
        decision: 'block',
        reason: 'top',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: 'x',
        },
      }),
      '',
      'Stop',
    )
    expect(mismatched).toMatchObject({
      decision: 'block',
      reason: 'top',
      hookEventName: 'PreToolUse',
    })
    expect(mismatched.additionalContext).toBeUndefined()
    const missing = parseHookOutput(
      0,
      JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }),
      '',
      'Stop',
    )
    expect(missing.decision).toBeUndefined()
  })

  it('is lenient: malformed JSON and plain text stay plain stdout', () => {
    expect(parseHookOutput(0, '{ not json', '').decision).toBeUndefined()
    const plain = parseHookOutput(0, '  plain text \n', '')
    expect(plain.stdout).toBe('plain text')
    expect(parseHookOutput(0, '[1,2]', '').decision).toBeUndefined()
  })
})

describe('mergeHookOutputs', () => {
  const out = (over: Partial<HookOutput> = {}): HookOutput => ({
    exitCode: 0,
    stderr: '',
    stdout: '',
    ...over,
  })

  it('yields a neutral outcome for no hooks', () => {
    expect(mergeHookOutputs([])).toEqual({
      decision: 'none',
      stop: false,
      additionalContext: [],
      systemMessages: [],
    })
  })

  it('deny > ask > allow regardless of order; block folds to deny', () => {
    expect(
      mergeHookOutputs([out({ decision: 'allow' }), out({ decision: 'ask' })])
        .decision,
    ).toBe('ask')
    expect(
      mergeHookOutputs([out({ decision: 'deny' }), out({ decision: 'ask' })])
        .decision,
    ).toBe('deny')
    expect(mergeHookOutputs([out({ decision: 'approve' })]).decision).toBe(
      'allow',
    )
    expect(
      mergeHookOutputs([out({ decision: 'allow' }), out({ decision: 'block' })])
        .decision,
    ).toBe('deny')
  })

  it('surfaces only the winning rank reasons, joined by a blank line', () => {
    expect(
      mergeHookOutputs([
        out({ decision: 'ask', reason: 'ask reason' }),
        out({ decision: 'deny', reason: 'first' }),
        out({ decision: 'allow', reason: 'ignored' }),
        out({ decision: 'block', reason: 'second' }),
      ]).reason,
    ).toBe('first\n\nsecond')
    expect(
      mergeHookOutputs([
        out({ decision: 'allow', reason: 'x' }),
        out({ decision: 'ask', reason: 'needs ok' }),
      ]).reason,
    ).toBe('needs ok')
  })

  it('stop is sticky on the first continue:false; context/system messages accumulate in order', () => {
    const merged = mergeHookOutputs([
      out({
        continue: false,
        stopReason: 'first',
        additionalContext: 'A',
        systemMessage: 'w1',
      }),
      out({ continue: false, stopReason: 'second', additionalContext: '' }),
      out({ additionalContext: 'B' }),
    ])
    expect(merged).toMatchObject({
      stop: true,
      stopReason: 'first',
      additionalContext: ['A', 'B'],
      systemMessages: ['w1'],
    })
  })
})

describe('summarizeStderr / detached runs', () => {
  it('trims, drops blank, and caps with an ellipsis', () => {
    expect(summarizeStderr('  \n', 500)).toBeUndefined()
    expect(summarizeStderr(' abc ', 500)).toBe('abc')
    expect(summarizeStderr('x'.repeat(600), 500)).toBe(`${'x'.repeat(500)}…`)
  })

  it('drain aborts the signal and waits for tracked chains, including late ones', async () => {
    const runs = createDetachedRuns()
    const log: string[] = []
    runs.track(
      new Promise<void>((resolve) => {
        runs.signal.addEventListener('abort', () => {
          setTimeout(() => {
            log.push('first')
            runs.track(
              Promise.resolve().then(() => {
                log.push('late')
              }),
            )
            resolve()
          }, 5)
        })
      }),
    )
    runs.track(Promise.reject(new Error('absorbed')))
    await runs.drain()
    expect(runs.signal.aborted).toBe(true)
    expect(log).toEqual(['first', 'late'])
  })
})

describe.skipIf(process.platform === 'win32')('runHook', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'emperor-hook-runner-')))
  const options = (over: Partial<RunHookOptions> = {}): RunHookOptions => ({
    payload: { hello: 'world' },
    cwd,
    signal: new AbortController().signal,
    trailingNewline: true,
    defaultTimeoutMs: 10_000,
    ...over,
  })

  it('writes the JSON payload (plus newline) to stdin and runs in cwd with the extra env', async () => {
    const { output, durationMs } = await runHook(
      { command: 'cat; pwd; printf "%s" "$HOOK_VAR"' },
      options({ env: { HOOK_VAR: 'v1' } }),
    )
    expect(output.exitCode).toBe(0)
    expect(output.stdout).toBe(`{"hello":"world"}\n${cwd}\nv1`)
    expect(durationMs).toBeGreaterThanOrEqual(0)
  })

  it('decodes exit 2 as a block with the stderr reason', async () => {
    const { output } = await runHook(
      { command: 'cat >/dev/null; echo "nope" >&2; exit 2' },
      options(),
    )
    expect(output).toMatchObject({
      exitCode: 2,
      decision: 'block',
      reason: 'nope',
    })
  })

  it('decodes structured stdout on exit 0', async () => {
    const json = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'check',
      },
    })
    const { output } = await runHook(
      { command: `printf '%s' '${json}'` },
      options({ expectedEventName: 'PreToolUse' }),
    )
    expect(output).toMatchObject({ decision: 'ask', reason: 'check' })
  })

  it('kills a hook at its timeout (no exit code, non-blocking)', async () => {
    const started = Date.now()
    const { output } = await runHook(
      { command: 'sleep 5' },
      options({ defaultTimeoutMs: 150 }),
    )
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(output.exitCode).toBeUndefined()
    expect(output.decision).toBeUndefined()
    expect(output.stderr).toContain('timed out after 150ms')
  })

  it('a per-hook timeout (seconds) overrides the default', async () => {
    const { output } = await runHook(
      { command: 'sleep 0.2; echo ok', timeoutSec: 5 },
      options({ defaultTimeoutMs: 50 }),
    )
    expect(output).toMatchObject({ exitCode: 0, stdout: 'ok' })
  })

  it('aborting the signal kills the hook', async () => {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 50)
    const { output } = await runHook(
      { command: 'sleep 5' },
      options({ signal: controller.signal }),
    )
    expect(output.exitCode).toBeUndefined()
    expect(output.stderr).toContain('cancelled')
  })

  it('an unusable cwd becomes a non-blocking failure instead of throwing', async () => {
    const { output } = await runHook(
      { command: 'true' },
      options({ cwd: join(cwd, 'missing') }),
    )
    expect(output.exitCode).toBeUndefined()
    expect(output.stderr).toContain('could not start')
  })
})
