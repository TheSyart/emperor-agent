import { expect, it } from 'vitest'
import { makeApi } from '../../api/test-helpers'
import { fixtureDelegationRecord } from './testing'
import { defaultExecutorConfig } from './config'

/** The renderer shows no session (KRN-01 view scope). */
const VIEW = { sessionId: null }

it('the consent card reaches the conversation as an approval and the answer comes back through control', async () => {
  const { api, events } = await makeApi()
  try {
    const root = String(api.sessions.create({ title: 'consent' }).id)
    const owner = {
      ...fixtureDelegationRecord().owner,
      rootSessionId: root,
      parentAgentId: root,
    }
    const profile = { ...defaultExecutorConfig().profiles[1]!, enabled: true }
    const decision = api.host.delegationConsent.decide({
      owner,
      profile,
      description: 'Review parser',
      signal: new AbortController().signal,
    })
    const [card] = api.host.pending.forSession(root)
    const asked = events.find((e) => e.event === 'ask_request') as
      | { interaction: { meta: Record<string, unknown>; questions: unknown } }
      | undefined
    expect(asked?.interaction.meta.interaction_type).toBe('permission')
    await api.control.answerInteraction(card!, {
      'executor-consent': {
        option_id: 'allow_always',
        choice: '以后都允许',
        freeform: '',
      },
    })
    expect(await decision).toBe(true)
    expect(api.executors.list().profiles[1]).toMatchObject({
      consent: 'always',
    })
  } finally {
    await api.close()
  }
})

it('turning an executor off in settings forgets "以后都允许"', async () => {
  const { api } = await makeApi()
  try {
    api.host.delegationConsent.store!.grant('codex-default')
    const listed = api.executors.list()
    const config = structuredClone(listed.config!)
    config.profiles[1]!.enabled = true
    const on = await api.executors.configure(
      {
        expectedRevision: config.revision,
        config,
      },
      VIEW,
    )
    expect(api.executors.list().profiles[1]!.consent).toBe('always')
    const off = structuredClone(on)
    off.profiles[1]!.enabled = false
    await api.executors.configure(
      {
        expectedRevision: on.revision,
        config: off,
      },
      VIEW,
    )
    expect(api.executors.list().profiles[1]!.consent).toBeNull()
  } finally {
    await api.close()
  }
})

it('a conversation with both external executors off carries no executor guidance', async () => {
  const { api, adapter } = await makeApi({ replies: [{ text: 'ok' }] })
  try {
    const id = String(api.sessions.create({ title: 'plain' }).id)
    await api.chat.submit({ content: 'hello', sessionId: id })
    const request = adapter.requests[0]!
    const prompt = JSON.stringify([request.system, request.messages])
    expect(prompt).not.toMatch(
      /External executor|External subagents|codex-default|claude-default|All backends/,
    )
  } finally {
    await api.close()
  }
})
