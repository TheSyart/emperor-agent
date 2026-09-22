import { afterEach, describe, expect, it } from 'vitest'
import {
  copySkillToUser,
  deleteSkill,
  getSkill,
  importSkills,
  listSkills,
  saveSkill,
  skillErrorInfo,
  validateSkill,
} from './skills'

const g = globalThis as unknown as { window?: any }

afterEach(() => {
  delete g.window
})

function bridge(reply: (key: string) => unknown = () => ({})) {
  const calls: unknown[][] = []
  g.window = {
    emperor: {
      invokeCore: async (...args: unknown[]) => {
        calls.push(args)
        return reply(String(args[0]))
      },
    },
  }
  return calls
}

describe('Skills API Core IPC', () => {
  it('scopes reads and writes to the session only when one is given', async () => {
    const calls = bridge()
    await listSkills()
    await listSkills({ sessionId: 'build-ui' })
    await getSkill('writer', { sessionId: null })
    await saveSkill('writer', '---\nname: writer\n---\n', {
      sessionId: 'build-ui',
    })
    expect(calls).toEqual([
      ['skills.list', {}],
      ['skills.list', { sessionId: 'build-ui' }],
      ['skills.get', 'writer', {}],
      [
        'skills.save',
        'writer',
        '---\nname: writer\n---\n',
        { sessionId: 'build-ui' },
      ],
    ])
  })

  it('deletes invalid Skills by folder name and scope', async () => {
    const calls = bridge()
    await deleteSkill('writer')
    await deleteSkill('broken_dir', { scope: 'user', sessionId: 's1' })
    expect(calls).toEqual([
      ['skills.delete', 'writer', {}],
      ['skills.delete', 'broken_dir', { sessionId: 's1', scope: 'user' }],
    ])
  })

  it('imports, copies and validates with only the options that are set', async () => {
    const calls = bridge()
    await importSkills({
      source: { kind: 'url', url: 'https://github.com/o/r' },
      scope: 'user',
    })
    await importSkills({
      source: { kind: 'content', content: 'x', name: 'n' },
      scope: 'project',
      sessionId: 'build-ui',
      overwrite: true,
    })
    await copySkillToUser({ name: 'skill-creator' })
    await copySkillToUser({ name: 'docx', overwrite: true, sessionId: 's1' })
    await validateSkill({ content: 'x', name: '  ' })
    await validateSkill({ name: 'writer', sessionId: 's1' })
    expect(calls).toEqual([
      [
        'skills.import',
        {
          source: { kind: 'url', url: 'https://github.com/o/r' },
          scope: 'user',
        },
      ],
      [
        'skills.import',
        {
          source: { kind: 'content', content: 'x', name: 'n' },
          scope: 'project',
          sessionId: 'build-ui',
          overwrite: true,
        },
      ],
      ['skills.copyToUser', { name: 'skill-creator' }],
      ['skills.copyToUser', { name: 'docx', sessionId: 's1', overwrite: true }],
      ['skills.validate', { content: 'x' }],
      ['skills.validate', { name: 'writer', sessionId: 's1' }],
    ])
  })

  it('surfaces SkillError code and action from the IPC envelope', async () => {
    bridge(() => ({
      ok: false,
      error: {
        message: 'A Skill named "x" already exists',
        code: 'skill_exists',
        action: 'overwrite',
      },
    }))
    const error = await copySkillToUser({ name: 'x' }).catch((e) => e)
    expect(skillErrorInfo(error)).toEqual({
      code: 'skill_exists',
      action: 'overwrite',
      message: 'A Skill named "x" already exists',
    })
    expect(skillErrorInfo('boom')).toEqual({
      code: null,
      action: null,
      message: 'boom',
    })
  })
})
