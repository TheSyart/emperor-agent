import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHighRiskCommand, isLowRiskCommand, isReadonlyCommand, isSensitivePath } from './tools/resolvers'
import { ToolRegistry } from './tools/registry'
import { Tool } from './tools/base'
import { S, toolParamsSchema } from './tools/schema'
import { WebSearchTool } from './tools/web-search'
import { pairToolCalls, capToolResults, shrinkOldToolResults, ContextPipeline, ToolResultStore } from './context/pipeline'
import { PermissionMode } from './permissions/models'
import { PermissionPipeline } from './permissions/pipeline'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── TOOL-005 command resolvers ──

describe('command resolvers', () => {
  it('high risk flags push/sudo/rm -rf/docker push/terraform apply etc', () => {
    expect(isHighRiskCommand('git push origin main')).toBe(true)
    expect(isHighRiskCommand('sudo rm -rf /')).toBe(true)
    expect(isHighRiskCommand('ls; rm -rf .')).toBe(true)
    expect(isHighRiskCommand('git status && sudo whoami')).toBe(true)
    expect(isHighRiskCommand('docker push image')).toBe(true)
    expect(isHighRiskCommand('terraform apply')).toBe(true)
    expect(isHighRiskCommand('pip install requests')).toBe(true)
  })

  it('non-high-risk commands pass through', () => {
    expect(isHighRiskCommand('pwd')).toBe(false)
    expect(isHighRiskCommand('git status')).toBe(false)
    expect(isHighRiskCommand('pytest tests/ -q')).toBe(false)
    expect(isHighRiskCommand('echo "rm -rf /"')).toBe(false)
    expect(isHighRiskCommand('printf "git push origin main"')).toBe(false)
  })

  it('low risk allowlist covers ls/pwd/pytest/git status|diff|log + npm test + python3 -m pytest', () => {
    expect(isLowRiskCommand('ls')).toBe(true)
    expect(isLowRiskCommand('pwd')).toBe(true)
    expect(isLowRiskCommand('pytest')).toBe(true)
    expect(isLowRiskCommand('git status')).toBe(true)
    expect(isLowRiskCommand('git log --oneline')).toBe(true)
    expect(isLowRiskCommand('npm test')).toBe(true)
    expect(isLowRiskCommand('python3 -m pytest tests/')).toBe(true)
  })

  it('low risk blocks chained/redirected commands', () => {
    expect(isLowRiskCommand('ls && rm -rf .')).toBe(false)
    expect(isLowRiskCommand('pwd; cat /etc/passwd')).toBe(false)
    expect(isLowRiskCommand('ls > /dev/null')).toBe(false)
    expect(isLowRiskCommand('git status\nrm -rf .')).toBe(false)
    expect(isLowRiskCommand('git status $(echo ok)')).toBe(false)
  })

  it('readonly excludes pytest/npm test (code execution)', () => {
    expect(isReadonlyCommand('ls')).toBe(true)
    expect(isReadonlyCommand('git status')).toBe(true)
    expect(isReadonlyCommand('pytest')).toBe(false)
    expect(isReadonlyCommand('npm test')).toBe(false)
    expect(isReadonlyCommand('npm test -- --run')).toBe(false)
  })

  it('sensitive path flags secrets, memory, git internals, traversal', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('memory/history.jsonl')).toBe(true)
    expect(isSensitivePath('../../etc/passwd')).toBe(true)
    expect(isSensitivePath('src/main.ts')).toBe(false)
    expect(isSensitivePath('.git/config')).toBe(true)
    expect(isSensitivePath('desktop/out/index.html')).toBe(true)
  })
})

// ── TOOL-003 registry + base ──

class EchoTool extends Tool {
  name = 'echo'
  description = 'echoes input'
  parameters = toolParamsSchema({ text: S('text to echo') })
  async execute(args: Record<string, unknown>) { return `echo: ${args.text}` }
}

describe('ToolRegistry', () => {
  it('registers tools, generates definitions, executes and casts params', async () => {
    const reg = new ToolRegistry()
    reg.register(new EchoTool())
    const defs = reg.getDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe('echo')
    expect(defs[0]!.description).toBe('echoes input')
    expect(defs[0]!.input_schema.properties.text).toMatchObject({ type: 'string' })

    const out = await reg.execute('echo', { text: 'hello' })
    expect(out).toBe('echo: hello')
  })

  it('rejects duplicate registration and unknown tools', () => {
    const reg = new ToolRegistry()
    reg.register(new EchoTool())
    expect(() => reg.register(new EchoTool())).toThrow(/already registered/)
    expect(() => reg.prepareCall('nope', {})).toThrow(/Unknown tool/)
  })

  it('web_search returns structured untrusted results from an adapter', async () => {
    const reg = new ToolRegistry()
    reg.register(new WebSearchTool({
      name: 'fake-search',
      search: async () => [
        {
          title: '<b>Result</b>',
          url: 'https://example.com/a',
          snippet: '<p>Snippet with <script>bad()</script> html</p>',
          source: 'example',
          timestamp: '2026-07-02T00:00:00Z',
        },
      ],
    }))

    const result = await reg.executeResult('web_search', { query: 'agent runtime', max_results: 1 })

    expect(result.isError).toBe(false)
    expect(result.metadata).toMatchObject({
      tool: 'web_search',
      untrusted: true,
      backend: 'fake-search',
      query: 'agent runtime',
    })
    expect(result.modelContent).toContain('[web_search_results]')
    expect(result.modelContent).toContain('UNTRUSTED')
    expect(result.modelContent).toContain('https://example.com/a')
    expect(result.modelContent).not.toContain('<script>')
  })

  it('web_search reports a clear backend-missing error by default', async () => {
    const reg = new ToolRegistry()
    reg.register(new WebSearchTool())

    const result = await reg.executeResult('web_search', { query: 'agent runtime' })

    expect(result.isError).toBe(true)
    expect(result.modelContent).toContain('web_search backend not configured')
    expect(result.metadata).toMatchObject({ tool: 'web_search', backend: 'missing' })
  })

  it('web_search is exposed as a read-only tool for Plan mode', () => {
    const registry = new ToolRegistry()
    registry.register(new WebSearchTool())
    const decision = new PermissionPipeline().assess('web_search', { query: 'agent runtime' }, PermissionMode.PLAN, { registry })

    expect(decision.allowed).toBe(true)
    expect(decision.rule).toBe('plan.read_only')
  })
})

// ── CORE-002/003/005 context_pipeline ──

describe('context_pipeline', () => {
  it('pairToolCalls backfills missing tool results and drops orphans', () => {
    const history = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    ]
    const [cleaned, filled, dropped] = pairToolCalls(history)
    expect(cleaned).toHaveLength(3)
    expect(cleaned[2]!).toEqual({
      role: 'tool', tool_call_id: 'call_1', name: 'read_file',
      content: '(tool execution interrupted)',
    })
    expect(filled).toBe(1)
    expect(dropped).toBe(0)
  })

  it('pairToolCalls drops orphan tool messages', () => {
    const history = [
      { role: 'tool', tool_call_id: 'orphan', name: 'read_file', content: 'bad' },
      { role: 'user', content: 'hello' },
    ]
    const [cleaned, _f, dropped] = pairToolCalls(history)
    expect(dropped).toBe(1)
    expect(cleaned).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('capToolResults keeps head + tail with truncation marker', () => {
    const text = 'a'.repeat(9000) + 'tail'
    const history = [{ role: 'tool', tool_call_id: 'call_1', name: 'grep', content: text }]
    const [capped, count] = capToolResults(history, 8000)
    expect(capped[0]!.content as string).toMatch(/^a{100}/)
    expect(capped[0]!.content as string).toMatch(/tail$/)
    expect(capped[0]!.content as string).toContain('truncated, total 9004 chars')
    expect(count).toBe(1)
  })

  it('shrinkOldToolResults shrinks old large tools beyond keep_recent', () => {
    const oldLarge = { role: 'tool', tool_call_id: 'old', name: 'grep', content: 'x'.repeat(2000) }
    const recentLarge = { role: 'tool', tool_call_id: 'recent', name: 'grep', content: 'y'.repeat(2000) }
    const history = [oldLarge, { role: 'user', content: 'middle' }, recentLarge]
    const [shrunk, count] = shrinkOldToolResults(history, 2, 100)
    expect(shrunk[0]!.content).toBe('[shrunk] grep → 2000 chars omitted')
    expect(shrunk[2]!.content).toBe('y'.repeat(2000))
    expect(count).toBe(1)
  })

  it('ContextPipeline.project chains all 4 governance steps', () => {
    const pipe = new ContextPipeline({ keepRecent: 2, microcompactKeepRecent: 5 })
    const proj = pipe.project([{ role: 'user', content: 'hi' }])
    expect(proj.messages).toHaveLength(1)
    expect(proj.filled).toBe(0)
    expect(proj.dropped).toBe(0)
  })

  it('replaces large tool results with stable artifact references', () => {
    const root = tmp('emperor-context-pipeline-')
    const content = 'x'.repeat(9000)
    const history = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', turn_id: 'turn_1', tool_call_id: 'call_1', name: 'grep', content },
    ]
    const pipeline = new ContextPipeline({
      toolResultStore: new ToolResultStore(root),
      replacementMinBytes: 2000,
      replacementPreviewChars: 120,
    })

    const projection = pipeline.project(history)
    const projectionAgain = pipeline.project(history)
    const toolMessage = projection.messages[1]!
    const replacement = (projection.report.tool_result_replacements as Array<Record<string, unknown>>)[0]!

    expect(projection.report.replaced_tool_results).toBe(1)
    expect(projectionAgain.messages[1]!.content).toBe(toolMessage.content)
    expect(projectionAgain.report.tool_result_replacements).toEqual(projection.report.tool_result_replacements)
    expect(readFileSync(join(root, String(replacement.artifact_path)), 'utf8')).toBe(content)
    expect(String(toolMessage.content)).toContain('Tool result stored outside the model context')
    expect(String(toolMessage.content)).toContain(String(replacement.artifact_path))
    expect(String(toolMessage.content)).toContain('original_chars: 9000')
    expect(String(toolMessage.content).length).toBeLessThan(1000)
  })

  it('replaces the largest tool results when a batch exceeds the aggregate budget', () => {
    const root = tmp('emperor-context-pipeline-aggregate-')
    const small = 's'.repeat(1000)
    const mediumA = 'a'.repeat(2600)
    const mediumB = 'b'.repeat(2200)
    const history = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_small', type: 'function', function: { name: 'grep', arguments: '{}' } },
          { id: 'call_a', type: 'function', function: { name: 'grep', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{}' } },
        ],
      },
      { role: 'tool', turn_id: 'turn_1', tool_call_id: 'call_small', name: 'grep', content: small },
      { role: 'tool', turn_id: 'turn_1', tool_call_id: 'call_a', name: 'grep', content: mediumA },
      { role: 'tool', turn_id: 'turn_1', tool_call_id: 'call_b', name: 'grep', content: mediumB },
    ]
    const pipeline = new ContextPipeline({
      toolResultStore: new ToolResultStore(root),
      replacementMinBytes: 10_000,
      replacementPreviewChars: 80,
      aggregateToolResultBudget: 3_500,
    })

    const projection = pipeline.project(history)
    const projectionAgain = pipeline.project(history)
    const report = projection.report as Record<string, unknown>
    const aggregateRecords = report.aggregate_tool_result_replacements as Array<Record<string, unknown>>
    const projectedSmall = projection.messages[1]!
    const projectedA = projection.messages[2]!
    const projectedB = projection.messages[3]!

    expect(report.replaced_tool_results).toBe(2)
    expect(report.per_call_replaced_tool_results).toBe(0)
    expect(report.aggregate_replaced_tool_results).toBe(2)
    expect(aggregateRecords.map((record) => record.tool_call_id)).toEqual(['call_a', 'call_b'])
    expect(projectedSmall.content).toBe(small)
    expect(String(projectedA.content)).toContain('Tool result stored outside the model context')
    expect(String(projectedB.content)).toContain('Tool result stored outside the model context')
    expect(projectionAgain.messages[2]!.content).toBe(projectedA.content)
    expect(projectionAgain.report.aggregate_tool_result_replacements).toEqual(aggregateRecords)
    expect(readFileSync(join(root, String(aggregateRecords[0]!.artifact_path)), 'utf8')).toBe(mediumA)
    expect(readFileSync(join(root, String(aggregateRecords[1]!.artifact_path)), 'utf8')).toBe(mediumB)
  })

  it('microcompacts old large text messages without touching tool-call messages', () => {
    const longText = 'alpha '.repeat(900)
    const recentText = 'beta '.repeat(900)
    const history = [
      { role: 'user', content: longText, turn_id: 'source_turn_1' },
      { role: 'assistant', content: 'short reply' },
      { role: 'user', content: recentText },
    ]

    const projection = new ContextPipeline({
      microcompactKeepRecent: 1,
      microcompactMinChars: 1000,
      microcompactHeadChars: 80,
      microcompactTailChars: 60,
    }).project(history, { turnId: 'turn_micro_1' })

    expect(projection.report.microcompacted_messages).toBe(1)
    const record = (projection.report.microcompact_records as Array<Record<string, unknown>>)[0]!
    expect(record).toMatchObject({
      index: 0,
      message_id: 'source_turn_1:0',
      source_turn_id: 'source_turn_1',
      role: 'user',
      original_chars: longText.length,
      kept_head_chars: 80,
      kept_tail_chars: 60,
      reason: 'older_text_over_microcompact_threshold',
    })
    expect(record.original_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(record.token_estimate).toBeGreaterThan(1000)
    expect(String(projection.messages[0]!.content)).toMatch(/^\[local_microcompact\]/)
    expect(String(projection.messages[0]!.content)).toContain('message_id: source_turn_1:0')
    expect(String(projection.messages[0]!.content)).toContain('original_chars:')
    expect(String(projection.messages[0]!.content)).toContain('token_estimate:')
    expect(String(projection.messages[0]!.content)).toContain('original_hash:')
    expect(String(projection.messages[0]!.content)).toContain('reason: older_text_over_microcompact_threshold')
    expect(String(projection.messages[0]!.content)).toContain('source_history_mutated: false')
    expect(String(projection.messages[0]!.content)).toContain('alpha alpha')
    expect(projection.messages[2]!.content).toBe(recentText)
    expect(history[0]!.content).toBe(longText)

    const preserved = new ContextPipeline({
      microcompactKeepRecent: 1,
      microcompactMinChars: 1000,
    }).project([
      { role: 'assistant', content: 'x'.repeat(3000), tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'ok' },
      { role: 'user', content: 'next' },
    ])
    expect(preserved.report.microcompacted_messages).toBe(0)
    expect((preserved.messages[0]!.tool_calls as Array<Record<string, unknown>>)[0]!.id).toBe('call_1')
  })

  it('microcompact message ids use the source turn index rather than the current model turn', () => {
    const longText = 'source '.repeat(300)
    const projection = new ContextPipeline({
      microcompactKeepRecent: 0,
      microcompactMinChars: 1000,
      microcompactHeadChars: 20,
      microcompactTailChars: 10,
    }).project([
      { role: 'user', content: longText, turn_id: 'source_a' },
      { role: 'assistant', content: longText, turn_id: 'source_a' },
      { role: 'user', content: longText, turn_id: 'source_b' },
      { role: 'user', content: longText },
    ], { turnId: 'current_turn' })

    expect((projection.report.microcompact_records as Array<Record<string, unknown>>).map((record) => record.message_id)).toEqual([
      'source_a:0',
      'source_a:1',
      'source_b:0',
      'history:3',
    ])
  })

  it('injects plan runtime context after projected history (2026-07-05 B3: tail, not head)', () => {
    // 计划上下文随状态频繁变化；放在数组开头会让每次调用整条前缀都不稳定，
    // DeepSeek 等按前缀字节匹配的缓存因此被逐字节击穿。放尾部只影响最后一条消息。
    const projection = new ContextPipeline({
      planContextProvider: () => ({ role: 'system', content: '[PLAN_RUNTIME_CONTEXT]\nplan_id: plan_1' }),
    }).project([{ role: 'user', content: 'continue' }])

    expect(projection.messages[0]).toEqual({ role: 'user', content: 'continue' })
    expect(String(projection.messages[1]!.content)).toMatch(/^\[PLAN_RUNTIME_CONTEXT\]/)
    expect(projection.report.plan_context_attached).toBe(1)
  })

  it('freezes the shrink/microcompact boundary at a caller-provided stableBoundary (2026-07-05 B3)', () => {
    const longText = 'x'.repeat(2000)
    const history = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'echo', content: longText },
    ]
    const pipeline = new ContextPipeline({ keepRecent: 2 })

    // turnStartLength=1（只有最初的 user 消息）；后续增长过程中 stableBoundary 冻结在 1
    const call2 = pipeline.project(history as never, { stableBoundary: 1 })
    const grown = [
      ...history,
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'echo', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', name: 'echo', content: longText },
    ]
    const call3 = pipeline.project(grown as never, { stableBoundary: 1 })

    // 不加 stableBoundary 时，call3 的 cutoff 会随 history.length 增长追上 tool1，把它从 call2 的原文变成 [shrunk]——
    // 这正是审计会话里 shrunk_old_tool_results 在几乎每次调用都命中的机制。冻结后 tool1 在两次调用间逐字节相同。
    expect(call3.messages[2]!.content).toBe(call2.messages[2]!.content)
    expect(call3.messages[2]!.content).toBe(longText)

    // 不传 stableBoundary 时保持旧行为（cutoff 随当前长度滑动），existing 测试的默认路径不受影响
    const withoutBoundary = pipeline.project(grown as never)
    expect(String(withoutBoundary.messages[2]!.content)).toContain('[shrunk]')
  })
})
