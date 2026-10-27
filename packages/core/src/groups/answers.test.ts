// GRP-12: what the user answered a member who asked in a group — a quick
// reply, their own words, 不回答, an approval's yes or no — turned into the
// line the group log keeps for the user only (「你回答了 架构师 的提问：…」).
import { describe, expect, it } from 'vitest'
import { answerText, groupAnswer } from './answers'

const QUESTION = {
  id: 'ask_q1',
  kind: 'ask',
  status: 'waiting',
  questions: [
    {
      id: 'scope',
      header: '范围',
      question: '先看哪一部分？',
      options: [{ label: '登录' }, { label: '注册' }],
    },
  ],
  meta: { interaction_type: 'question', question_id: 'q1' },
}

const APPROVAL = {
  id: 'approval_a1',
  kind: 'ask',
  status: 'waiting',
  questions: [
    {
      id: 'permission',
      header: '权限',
      question: '运行测试需要网络',
      options: [
        { id: 'allow_once', label: '允许本次' },
        { id: 'deny', label: '拒绝' },
      ],
    },
  ],
  meta: {
    interaction_type: 'permission',
    approval_id: 'a1',
    permission: {
      version: 2,
      operation_count: 1,
      operations: [
        {
          tool_name: 'bash',
          risk: 'escalation',
          reason: '运行测试需要网络',
          summary: 'npm test',
        },
      ],
    },
  },
}

const CONSENT = {
  id: 'ask_c1',
  kind: 'ask',
  status: 'waiting',
  questions: [
    {
      id: 'executor-consent',
      header: '子智能体',
      question: '第一次使用 Codex',
      options: [
        { id: 'deny', label: '不允许' },
        { id: 'allow_once', label: '本次允许' },
        { id: 'allow_always', label: '以后都允许' },
      ],
    },
  ],
  meta: {
    interaction_type: 'permission',
    question_id: 'c1',
    executor_consent: { backend: 'codex', profileId: 'codex' },
    permission: {
      version: 2,
      operation_count: 1,
      operations: [
        {
          tool_name: 'Codex',
          risk: 'quota',
          reason: '第一次使用 Codex',
          summary: '用你的 Codex 额度读这个项目',
        },
      ],
    },
  },
}

const PLAN = {
  id: 'plan_p1',
  kind: 'plan',
  status: 'waiting',
  title: '登录页拆分计划',
  plan_markdown: '# 登录页拆分计划\n\n1. 拆表单',
  meta: { question_id: 'p1', review_question_id: 'plan-review' },
}

describe('what the user answered, as the group keeps it (GRP-12)', () => {
  it('a quick reply answers the question with the option picked', () => {
    expect(
      groupAnswer('ask_q1', QUESTION, {
        action: 'answer',
        answers: { scope: { choice: '登录', freeform: '' } },
      }),
    ).toEqual({
      outcome: 'answered',
      subject: 'question',
      asked: '先看哪一部分？',
      reply: '登录',
    })
  })

  it('the user’s own words are the reply, after any option picked', () => {
    expect(
      groupAnswer('ask_q1', QUESTION, {
        action: 'answer',
        answers: { scope: { choice: '', freeform: '两个都看' } },
      })?.reply,
    ).toBe('两个都看')
    expect(
      groupAnswer('ask_q1', QUESTION, {
        action: 'answer',
        answers: { scope: { choice: '注册', freeform: '顺便看找回密码' } },
      })?.reply,
    ).toBe('注册 · 顺便看找回密码')
  })

  it('several questions are answered in order, each one kept', () => {
    const asked = {
      ...QUESTION,
      questions: [
        { id: 'a', question: '先看哪里？', options: [{ label: '登录' }] },
        {
          id: 'b',
          question: '要哪些检查？',
          multi_select: true,
          options: [{ label: '安全' }, { label: '性能' }],
        },
      ],
    }
    expect(
      groupAnswer('ask_q1', asked, {
        action: 'answer',
        answers: {
          a: { choice: '登录', freeform: '' },
          b: { selected: ['安全', '性能'] },
        },
      }),
    ).toMatchObject({
      asked: '先看哪里？；要哪些检查？',
      reply: '登录；安全、性能',
    })
  })

  it('不回答 leaves the question unanswered', () => {
    expect(groupAnswer('ask_q1', QUESTION, { action: 'cancel' })).toEqual({
      outcome: 'skipped',
      subject: 'question',
      asked: '先看哪一部分？',
      reply: '',
    })
  })

  it('an approval is approved only by its allow option, denied otherwise', () => {
    expect(
      groupAnswer('approval_a1', APPROVAL, {
        action: 'answer',
        answers: {
          permission: {
            option_id: 'allow_once',
            choice: '允许本次',
            freeform: '',
          },
        },
      }),
    ).toEqual({
      outcome: 'approved',
      subject: 'approval',
      asked: 'npm test',
      reply: '允许本次',
    })
    expect(
      groupAnswer('approval_a1', APPROVAL, {
        action: 'answer',
        answers: {
          permission: { option_id: 'deny', choice: '拒绝', freeform: '' },
        },
      }),
    ).toMatchObject({ outcome: 'denied', asked: 'npm test' })
    // Words alone never allow, as Core decides the approval itself.
    expect(
      groupAnswer('approval_a1', APPROVAL, {
        action: 'answer',
        answers: { permission: { choice: '允许本次', freeform: '' } },
      })?.outcome,
    ).toBe('denied')
  })

  it('Claude Code or Codex’s first use is an approval too', () => {
    expect(
      groupAnswer('ask_c1', CONSENT, {
        action: 'answer',
        answers: {
          'executor-consent': {
            option_id: 'allow_always',
            choice: '以后都允许',
            freeform: '',
          },
        },
      }),
    ).toEqual({
      outcome: 'approved',
      subject: 'approval',
      asked: '用你的 Codex 额度读这个项目',
      reply: '以后都允许',
    })
    expect(
      groupAnswer('ask_c1', CONSENT, {
        action: 'answer',
        answers: {
          'executor-consent': { option_id: 'deny', choice: '不允许' },
        },
      })?.outcome,
    ).toBe('denied')
    expect(groupAnswer('ask_c1', CONSENT, { action: 'cancel' })).toMatchObject({
      outcome: 'skipped',
      subject: 'approval',
    })
  })

  it('a plan is approved or commented on', () => {
    expect(groupAnswer('plan_p1', PLAN, { action: 'approvePlan' })).toEqual({
      outcome: 'approved',
      subject: 'plan',
      asked: '登录页拆分计划',
      reply: '',
    })
    expect(
      groupAnswer('plan_p1', PLAN, {
        action: 'commentPlan',
        comment: '先别动注册',
      }),
    ).toMatchObject({ outcome: 'answered', reply: '先别动注册' })
    expect(
      groupAnswer('plan_p1', PLAN, {
        action: 'answer',
        answers: { 'plan-review': { choice: 'Approve', freeform: '' } },
      })?.outcome,
    ).toBe('approved')
  })

  it('keeps no line for a computer-use grant, and reads what it can without the card', () => {
    expect(groupAnswer('grant_g1', null, { action: 'cancel' })).toBeNull()
    expect(
      groupAnswer('ask_q9', null, {
        action: 'answer',
        answers: { scope: { choice: '登录', freeform: '' } },
      }),
    ).toEqual({
      outcome: 'answered',
      subject: 'question',
      asked: '',
      reply: '登录',
    })
    expect(
      groupAnswer('approval_a9', null, { action: 'cancel' }),
    ).toMatchObject({ outcome: 'skipped', subject: 'approval' })
  })

  it('one plain line each, long text cut short', () => {
    const note = (over: Partial<Parameters<typeof answerText>[0]>) => ({
      outcome: 'answered' as const,
      subject: 'question' as const,
      asked: '先看哪一部分？',
      reply: '登录',
      ...over,
    })
    expect(answerText(note({}), '架构师')).toBe('你回答了 架构师 的提问：登录')
    expect(
      answerText(
        note({ outcome: 'approved', subject: 'approval', asked: 'npm test' }),
        '架构师',
      ),
    ).toBe('你批准了 架构师 的请求：npm test')
    expect(
      answerText(
        note({ outcome: 'denied', subject: 'approval', asked: 'npm test' }),
        '架构师',
      ),
    ).toBe('你拒绝了 架构师 的请求：npm test')
    expect(answerText(note({ outcome: 'skipped', reply: '' }), '研究员')).toBe(
      '你没有回答 研究员 的提问：先看哪一部分？',
    )
    expect(
      answerText(
        note({ outcome: 'approved', subject: 'plan', asked: '拆分计划' }),
        '架构师',
      ),
    ).toBe('你批准了 架构师 的计划：拆分计划')
    expect(
      answerText(note({ subject: 'plan', reply: '先别动注册' }), '架构师'),
    ).toBe('你对 架构师 的计划提了意见：先别动注册')
    expect(answerText(note({ reply: '' }), '架构师')).toBe(
      '你回答了 架构师 的提问',
    )
    const long = answerText(note({ reply: '很长'.repeat(200) }), '架构师')
    expect(Array.from(long).length).toBeLessThan(220)
    expect(long.endsWith('…')).toBe(true)
    expect(answerText(note({ reply: '第一行\n\n第二行' }), '架构师')).toBe(
      '你回答了 架构师 的提问：第一行 第二行',
    )
  })
})
