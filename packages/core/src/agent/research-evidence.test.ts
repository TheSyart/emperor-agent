import { describe, expect, it } from 'vitest'
import type { ToolCallRequest } from '../providers/base'
import { ToolResultObj } from '../tools/base'
import {
  ResearchEvidenceLedger,
  assessResearchRequirement,
  parseGroundingReviewVerdict,
  validateResearchReply,
} from './research-evidence'

function call(name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id: `call_${name}`, name, arguments: args }
}

describe('ResearchEvidenceLedger', () => {
  it('keeps generic command URLs as candidates until web_fetch verifies a 2xx body', () => {
    const ledger = new ResearchEvidenceLedger()
    ledger.recordToolResult(
      call('run_command', {
        command: 'agent-reach search politics',
      }),
      ToolResultObj.fromText('Headline https://news.example/politics', {
        meta: {
          outcome: 'success',
          evidence_disposition: 'candidate',
        },
      }),
      { externalContent: true },
    )

    expect(ledger.snapshot()).toMatchObject({
      candidates: [
        expect.objectContaining({
          url: 'https://news.example/politics',
          disposition: 'candidate',
        }),
      ],
      verified: [],
    })

    ledger.recordToolResult(
      call('web_fetch', { url: 'https://news.example/politics' }),
      ToolResultObj.fromText('Verified article body', {
        meta: {
          outcome: 'success',
          http_status: 200,
          url: 'https://news.example/politics',
          success_scope: 'response_body',
        },
      }),
      { externalContent: true },
    )

    expect(ledger.snapshot()).toMatchObject({
      candidates: [],
      verified: [
        expect.objectContaining({
          id: 'source_1',
          url: 'https://news.example/politics',
          disposition: 'verified',
          excerpt: 'Verified article body',
        }),
      ],
    })
  })

  it('never verifies failed fetches, placeholders, credentials, or URLs found only in empty success output', () => {
    const ledger = new ResearchEvidenceLedger()
    ledger.recordToolResult(
      call('web_fetch', { url: 'https://news.example/missing' }),
      ToolResultObj.fromText('404 not found', {
        isError: true,
        meta: {
          outcome: 'failure',
          http_status: 404,
          url: 'https://news.example/missing',
        },
      }),
      { externalContent: true },
    )
    ledger.recordToolResult(
      call('run_command', { command: 'printf nothing' }),
      ToolResultObj.fromText(
        'https://.../... https://user:secret@news.example/private',
        { meta: { outcome: 'success' } },
      ),
      { externalContent: true },
    )
    ledger.recordToolResult(
      call('run_command', { command: 'true' }),
      ToolResultObj.fromText('', { meta: { outcome: 'success' } }),
      { externalContent: true },
    )

    expect(ledger.snapshot()).toEqual({
      candidates: [],
      verified: [],
    })
  })

  it('preserves manually validated redirect aliases when the final URL is fetched', () => {
    const ledger = new ResearchEvidenceLedger()
    ledger.recordToolResult(
      call('web_fetch', { url: 'https://news.example/start' }),
      ToolResultObj.fromText('redirect', {
        meta: {
          outcome: 'followup_required',
          original_url: 'https://news.example/start',
          redirect_url: 'https://publisher.example/story',
          http_status: 302,
        },
      }),
      { externalContent: true },
    )
    ledger.recordToolResult(
      call('web_fetch', { url: 'https://publisher.example/story' }),
      ToolResultObj.fromText('Verified redirected article body', {
        meta: {
          outcome: 'success',
          http_status: 200,
          url: 'https://publisher.example/story',
          success_scope: 'response_body',
        },
      }),
      { externalContent: true },
    )

    const snapshot = ledger.snapshot()
    expect(snapshot.candidates).toEqual([])
    expect(snapshot.verified).toEqual([
      expect.objectContaining({
        url: 'https://publisher.example/story',
        aliases: expect.arrayContaining([
          'https://news.example/start',
          'https://publisher.example/story',
        ]),
      }),
    ])
    expect(
      validateResearchReply(
        '报道已经发布。[来源](https://news.example/start)',
        snapshot.verified,
      ).passed,
    ).toBe(true)
  })
})

describe('research requirement policy', () => {
  it.each([
    '搜索今日政治新闻',
    'Find the latest election news on the internet',
    '看看 https://example.com/report 讲了什么',
  ])(
    'requires external evidence for %s without relying on Skill metadata',
    (text) => {
      expect(assessResearchRequirement(text, false).required).toBe(true)
    },
  )

  it('does not confuse local code search with internet research', () => {
    expect(
      assessResearchRequirement('在本项目搜索 ResearchEvidenceLedger', false),
    ).toEqual({ required: false, reason: 'none' })
  })

  it('keeps Skill metadata as an independent activation source', () => {
    expect(assessResearchRequirement('summarize it', true)).toEqual({
      required: true,
      reason: 'skill',
    })
  })
})

describe('research reply validation', () => {
  const sources = [
    {
      id: 'source_1',
      url: 'https://news.example/a',
      aliases: ['https://news.example/a'],
      disposition: 'verified' as const,
      transport: 'web_fetch',
      toolCallId: 'fetch_a',
      contentSha256: 'a'.repeat(64),
      excerpt: 'A happened on Tuesday.',
    },
    {
      id: 'source_2',
      url: 'https://news.example/b',
      aliases: ['https://news.example/b'],
      disposition: 'verified' as const,
      transport: 'web_fetch',
      toolCallId: 'fetch_b',
      contentSha256: 'b'.repeat(64),
      excerpt: 'B happened on Wednesday.',
    },
  ]

  it('requires a verified source on every factual unit instead of accepting one URL anywhere', () => {
    const result = validateResearchReply(
      [
        '- 事件 A 已于周二发生。[来源](https://news.example/a)',
        '- 事件 B 已于周三发生。',
        '',
        '来源：',
        '- [事件 B](https://news.example/b)',
      ].join('\n'),
      sources,
    )

    expect(result.passed).toBe(false)
    expect(result.reasonCodes).toContain('uncited_claim_unit')
    expect(result.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'unit_2', citedSourceIds: [] }),
      ]),
    )
  })

  it('accepts ordinary Markdown links when each factual unit cites a verified source', () => {
    const result = validateResearchReply(
      [
        '- 事件 A 已于周二发生。[来源](https://news.example/a)',
        '- 事件 B 已于周三发生。[来源](https://news.example/b)',
      ].join('\n'),
      sources,
    )

    expect(result).toMatchObject({
      passed: true,
      reasonCodes: [],
      citedSourceIds: ['source_1', 'source_2'],
    })
  })

  it('rejects fabricated, placeholder, and raw unverified URLs', () => {
    const result = validateResearchReply(
      '- 新闻已经确认。[来源](https://.../...) https://fabricated.example/story',
      sources,
    )

    expect(result.passed).toBe(false)
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['invalid_citation_url', 'unverified_url']),
    )
  })
})

describe('grounding reviewer verdict', () => {
  it('accepts only the exact bounded reviewer JSON contract', () => {
    expect(
      parseGroundingReviewVerdict(
        JSON.stringify({
          passed: false,
          unsupported_unit_ids: ['unit_2'],
          reason_codes: ['source_does_not_support_claim'],
        }),
      ),
    ).toEqual({
      passed: false,
      unsupportedUnitIds: ['unit_2'],
      reasonCodes: ['source_does_not_support_claim'],
    })

    expect(parseGroundingReviewVerdict('passed: true')).toBeNull()
    expect(
      parseGroundingReviewVerdict(
        JSON.stringify({ passed: true, unsupported_unit_ids: [] }),
      ),
    ).toBeNull()
  })
})
