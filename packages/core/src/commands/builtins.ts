import type {
  CommandArgumentSpec,
  CommandBusyPolicy,
  CommandDescriptor,
  CommandInvocationSource,
  CommandKind,
  CommandSurface,
} from './types'

const DESKTOP: CommandInvocationSource[] = ['desktop']
const READ_SAFE: CommandInvocationSource[] = ['desktop', 'automation', 'acp']

interface BuiltinSpec {
  name: string
  aliases?: string[]
  hiddenAliases?: string[]
  category: string
  description: string
  kind?: CommandKind
  busyPolicy?: CommandBusyPolicy
  args?: CommandArgumentSpec[]
  argumentHint?: string
  sources?: CommandInvocationSource[]
  surface?: CommandSurface
  dangerous?: boolean
}

/** Permission presets a session can run under (`/permissions <preset>`). */
export const PERMISSION_PRESET_VALUES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const

const specs: BuiltinSpec[] = [
  action(
    'new',
    'Commands',
    'Start a blank chat in this workspace',
    'after_turn',
  ),
  action(
    'compact',
    'Commands',
    'Free up context while keeping a summary',
    'after_turn',
  ),
  ui('model', 'Commands', 'Choose the model for this chat', 'model', {
    argumentHint: '[model-id]',
    args: [idArg('model-id')],
  }),
  ui(
    'reasoning',
    'Commands',
    'Choose how deeply the model thinks',
    'reasoning',
    {
      argumentHint: '[level]',
      args: [stringArg('level')],
    },
  ),
  ui('permissions', 'Commands', 'Choose what Emperor may do', 'permissions', {
    hiddenAliases: ['permission'],
    argumentHint: `[${PERMISSION_PRESET_VALUES.join('|')}]`,
    args: [enumArg('preset', [...PERMISSION_PRESET_VALUES, 'status'])],
  }),
  action('plan', 'Commands', 'Plan before making changes', 'immediate', {
    argumentHint: '[off|message]',
    args: [stringArg('off-or-message', true)],
  }),
  action('goal', 'Commands', 'Keep working toward an outcome', 'immediate', {
    argumentHint: '[<objective>|clear|edit <objective>|pause|resume]',
    args: [stringArg('objective-or-action', true)],
  }),
  action('stop', 'Commands', 'Stop the current task', 'immediate', {
    sources: READ_SAFE,
  }),
  action('continue', 'Commands', 'Resume the paused task', 'after_turn'),
]

export function builtinCommandDescriptors(): CommandDescriptor[] {
  return specs.map((spec) => ({
    id: `builtin.${spec.name}`,
    name: spec.name,
    aliases: [...(spec.aliases ?? [])],
    hiddenAliases: [...(spec.hiddenAliases ?? [])],
    category: spec.category,
    description: spec.description,
    kind: spec.kind ?? 'local_ui',
    source: 'builtin',
    busyPolicy: spec.busyPolicy ?? 'immediate',
    argumentSchema: (spec.args ?? []).map((arg) => ({ ...arg })),
    argumentHint: spec.argumentHint,
    userInvocable: true,
    invocationSources: [...(spec.sources ?? DESKTOP)],
    available: true,
    uiSurface: spec.surface,
    dangerous: spec.dangerous,
  }))
}

function ui(
  name: string,
  category: string,
  description: string,
  surface: CommandSurface,
  extra: Partial<BuiltinSpec> = {},
): BuiltinSpec {
  return { name, category, description, surface, kind: 'local_ui', ...extra }
}

function action(
  name: string,
  category: string,
  description: string,
  busyPolicy: CommandBusyPolicy,
  extra: Partial<BuiltinSpec> = {},
): BuiltinSpec {
  return {
    name,
    category,
    description,
    kind: 'core_action',
    busyPolicy,
    ...extra,
  }
}

function stringArg(name: string, variadic = false): CommandArgumentSpec {
  return { name, type: 'string', positional: true, variadic }
}
function enumArg(name: string, values: string[]): CommandArgumentSpec {
  return { name, type: 'enum', positional: true, values }
}
function idArg(name: string): CommandArgumentSpec {
  return { name, type: 'id', positional: true }
}
