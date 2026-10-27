/**
 * GRP-05: the contact profile's words — the user's rating out of their
 * 👍 / 👎, the versions newest first, and what changed between two of them
 * (card tests: 档案四个数字；版本对比与退回).
 */
import { describe, expect, it } from 'vitest'
import type { Contact } from '@emperor/core/api'
import {
  profileVersions,
  ratingSummary,
  versionChanges,
} from './contactProfileModel'

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'ct-reviewer00001',
    kind: 'local',
    name: '审稿人',
    avatar: { kind: 'library', id: 'AV-01-2' },
    intro: '代码与方案评审',
    domains: ['engineering'],
    role: {
      mission: '审查改动。',
      deliverable: '问题清单。',
      playbook: '1. 读改动\n2. 列问题',
      boundaries: '不改代码。',
      knowledge: [],
    },
    capabilities: {
      model: 'inherit',
      tools: { preset: 'read_only' },
      permission: 'read_only',
    },
    groupHabit: { speak: 'relevant', length: 'brief' },
    memory: { enabled: true },
    version: 3,
    builtin: false,
    createdAt: 1,
    updatedAt: 3_000,
    ...overrides,
  }
}

describe('ratingSummary', () => {
  it('is the share of 👍 over every rating', () => {
    expect(ratingSummary({ up: 10, down: 2 })).toEqual({
      value: '83%',
      label: '你的评分（12 次）',
      detail: '12 次反馈里 10 次 👍、2 次 👎',
    })
    expect(ratingSummary({ up: 0, down: 1 }).value).toBe('0%')
  })

  it('says so when there is none yet', () => {
    expect(ratingSummary({ up: 0, down: 0 })).toEqual({
      value: '—',
      label: '你的评分（还没有）',
      detail: '在单聊里给回答点 👍 或 👎 就会记在这里',
    })
  })
})

describe('profileVersions', () => {
  it('lists the current version first, then the saved ones', () => {
    const current = contact({ version: 3, updatedAt: 3_000 })
    const rows = profileVersions(current, [
      { version: 2, savedAt: 2_000, contact: contact({ version: 2 }) },
      { version: 1, savedAt: 1_000, contact: contact({ version: 1 }) },
    ])
    expect(rows.map((row) => [row.version, row.current, row.savedAt])).toEqual([
      [3, true, 3_000],
      [2, false, 2_000],
      [1, false, 1_000],
    ])
  })
})

describe('versionChanges', () => {
  it('names each field that differs, with what it was and what it is', () => {
    const older = contact({ version: 2 })
    const newer = contact({
      intro: '只看安全问题',
      role: { ...older.role, boundaries: '不改代码，不联网。' },
      capabilities: {
        ...older.capabilities,
        tools: { preset: 'research' },
      },
      groupHabit: { speak: 'mentioned', length: 'brief' },
    })
    expect(versionChanges(older, newer)).toEqual([
      {
        key: 'intro',
        label: '简介',
        before: '代码与方案评审',
        after: '只看安全问题',
      },
      {
        key: 'boundaries',
        label: '边界',
        before: '不改代码。',
        after: '不改代码，不联网。',
      },
      { key: 'tools', label: '工具', before: '只读', after: '调研' },
      {
        key: 'speak',
        label: '群聊里发言',
        before: '和职责相关时举手',
        after: '只在被点名时',
      },
    ])
  })

  it('finds nothing between equal versions', () => {
    expect(versionChanges(contact(), contact({ version: 9 }))).toEqual([])
  })
})
