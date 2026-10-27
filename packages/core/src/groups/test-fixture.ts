/**
 * An in-memory group store for tests: sessions, logs and contacts held in
 * maps, ids counted from 1 (GRP-06, GRP-07).
 */
import { GroupService, type GroupContact, type GroupLog } from './service'
import type { GroupSessionEntry } from './service'

export const TEST_CONTACTS: GroupContact[] = [
  {
    id: 'ct-emperor',
    name: 'Emperor',
    intro: '主持人',
    kind: 'local',
    speak: 'relevant',
    version: 1,
  },
  {
    id: 'ct-arch',
    name: '架构师',
    intro: '系统设计',
    kind: 'local',
    speak: 'relevant',
    version: 1,
  },
  {
    id: 'ct-rev',
    name: '审稿人',
    intro: '评审',
    kind: 'local',
    speak: 'relevant',
    version: 1,
  },
  {
    id: 'ct-codex',
    name: 'Codex',
    intro: '外部',
    kind: 'external',
    speak: 'mentioned',
    version: 1,
  },
  {
    id: 'ct-res',
    name: '研究员',
    intro: '调研',
    kind: 'local',
    speak: 'relevant',
    version: 1,
  },
]

export function memoryGroups(contacts: GroupContact[] = TEST_CONTACTS) {
  const sessions = new Map<string, GroupSessionEntry>()
  const logs = new Map<string, { type: string; data: unknown }[]>()
  let n = 0
  let clock = 1_700_000_000_000
  const service = new GroupService({
    sessions: {
      create: (title, opts) => {
        const id = opts.id ?? `s${++n}`
        const entry: GroupSessionEntry = {
          id,
          title,
          surface: opts.surface,
          ...(opts.contactId ? { contact_id: opts.contactId } : {}),
          ...(opts.groupId ? { group_id: opts.groupId } : {}),
        }
        sessions.set(id, entry)
        return entry
      },
      get: (id) => sessions.get(id) ?? null,
      list: () => [...sessions.values()],
      rename: () => true,
    },
    log: (id): GroupLog => {
      const events = logs.get(id) ?? []
      logs.set(id, events)
      return {
        events,
        append: (type, data) => void events.push({ type, data }),
      }
    },
    contact: (id) => contacts.find((c) => c.id === id) ?? null,
    newId: (prefix) => `${prefix}${++n}`,
    now: () => (clock += 1000),
  })
  return { service, sessions, logs }
}
