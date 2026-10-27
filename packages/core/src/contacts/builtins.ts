import {
  BUILTIN_CONTACT_IDS,
  EXTERNAL_CAPABILITIES,
  type BuiltinContactId,
  type Contact,
  type ExternalBackend,
  type RoleCard,
} from './types'

/** What a builtin contact lets the user change; the rest is the shipped definition. */
export const BUILTIN_EDITABLE_FIELDS = ['avatar', 'intro'] as const

export const BACKEND_LABELS: Readonly<Record<ExternalBackend, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

export function isBuiltinContactId(id: string): id is BuiltinContactId {
  return (BUILTIN_CONTACT_IDS as readonly string[]).includes(id)
}

function emptyRole(): RoleCard {
  return {
    mission: '',
    deliverable: '',
    playbook: '',
    boundaries: '',
    knowledge: [],
  }
}

function external(
  id: BuiltinContactId,
  backend: ExternalBackend,
  intro: string,
  at: number,
): Contact {
  return {
    id,
    kind: 'external',
    backend,
    name: BACKEND_LABELS[backend],
    avatar: { kind: 'logo', backend },
    intro,
    domains: ['engineering'],
    role: emptyRole(),
    capabilities: structuredClone(EXTERNAL_CAPABILITIES),
    groupHabit: { speak: 'mentioned', length: 'detailed' },
    memory: { enabled: true },
    version: 1,
    builtin: true,
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * The three builtin contacts as shipped. Emperor's role card is today's
 * persona; Claude Code and Codex take their model and permission from
 * 设置 › 子智能体, so their capabilities are only {@link EXTERNAL_CAPABILITIES}.
 */
export function builtinContacts(persona: string, at: number): Contact[] {
  return [
    {
      id: 'ct-emperor',
      kind: 'local',
      name: 'Emperor',
      avatar: { kind: 'mascot', pose: 'crown-head' },
      intro: '你的主智能体：统筹、拆解任务，在群里主持讨论',
      domains: ['engineering', 'decision'],
      role: { ...emptyRole(), mission: persona },
      capabilities: {
        model: 'inherit',
        tools: { preset: 'engineer' },
        permission: 'inherit',
      },
      groupHabit: { speak: 'relevant', length: 'brief' },
      memory: { enabled: true },
      version: 1,
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    external(
      'ct-claude-code',
      'claude-code',
      '外部编程智能体，模型和权限跟随子智能体设置',
      at,
    ),
    external(
      'ct-codex',
      'codex',
      '外部编程智能体，模型和权限跟随子智能体设置',
      at,
    ),
  ]
}
