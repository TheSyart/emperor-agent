import type { ToolPermissionProfile } from './models'
import { analyzeShellCommandFailClosed } from './shell-ast'
import {
  ConfigResolver,
  defineConfigKey,
  type ConfigCandidate,
  type ConfigLayerKind,
  type ConfigSourceTrust,
} from '../config/resolver'

export type PermissionRuleAction = 'allow' | 'ask' | 'deny'
export type PermissionRuleTrust =
  | 'system'
  | 'managed'
  | 'user'
  | 'project'
  | 'runtime'
  | 'untrusted'
  | 'unknown'

export interface PermissionRuleSource {
  kind: string
  id: string
  trust: PermissionRuleTrust
}

export interface PermissionRuleLayerInput {
  source: PermissionRuleSource
  rules: PermissionRuleInput[]
}

export interface PermissionRuleInput {
  id?: unknown
  action?: unknown
  tool?: unknown
  commandPrefix?: unknown
  command_prefix?: unknown
  pathGlob?: unknown
  path_glob?: unknown
  access?: unknown
  reason?: unknown
}

export interface PermissionRule {
  id: string
  action: PermissionRuleAction
  tool: string
  commandPrefix: string
  pathGlob: string
  access: string
  reason: string
  source: PermissionRuleSource
  inputIndex: number
  specificity: number
}

export interface PermissionRuleCandidate {
  id: string
  action: PermissionRuleAction
  matched: boolean
  source: PermissionRuleSource
  precedence: string
}

export interface PermissionRuleResolution {
  winner: PermissionRule | null
  candidates: PermissionRuleCandidate[]
}

export interface PermissionRuleDiagnostics {
  loaded: number
  invalid: number
  invalidRules: Array<{ index: number; reason: string }>
}

export interface PermissionRuleSet {
  rules: PermissionRule[]
  diagnostics: PermissionRuleDiagnostics
}

export function parsePermissionRules(rawRules: unknown): PermissionRuleSet {
  return parsePermissionRuleLayers([
    {
      source: {
        kind: 'local_config',
        id: 'emperor.local.json',
        trust: 'user',
      },
      rules: Array.isArray(rawRules) ? (rawRules as PermissionRuleInput[]) : [],
    },
  ])
}

export function parsePermissionRuleLayers(
  layers: PermissionRuleLayerInput[],
): PermissionRuleSet {
  const orderedLayers = resolvePermissionRuleLayers(layers)
  const rules: PermissionRule[] = []
  const invalidRules: Array<{ index: number; reason: string }> = []
  let inputIndex = 0
  for (const layer of orderedLayers) {
    const source = normalizeSource(layer.source)
    const inputs = Array.isArray(layer.rules) ? layer.rules : []
    inputs.forEach((raw) => {
      const index = inputIndex++
      const data =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as PermissionRuleInput)
          : null
      if (!data) {
        invalidRules.push({ index, reason: 'rule must be an object' })
        return
      }
      const id = safeRuleId(data.id)
      const action = safeAction(data.action)
      if (!id) {
        invalidRules.push({ index, reason: 'rule id is required' })
        return
      }
      if (!action) {
        invalidRules.push({
          index,
          reason: 'rule action must be allow, ask, or deny',
        })
        return
      }
      const tool = String(data.tool ?? '').trim()
      const commandPrefix = String(
        data.commandPrefix ?? data.command_prefix ?? '',
      ).trim()
      const pathGlob = String(data.pathGlob ?? data.path_glob ?? '').trim()
      const access = String(data.access ?? '')
        .trim()
        .toLowerCase()
      const reason =
        String(data.reason ?? '').trim() || `matched permission rule ${id}`
      if (!tool && !commandPrefix && !pathGlob && !access) {
        invalidRules.push({
          index,
          reason: 'rule must define at least one matcher',
        })
        return
      }
      const specificity = [tool, commandPrefix, pathGlob, access].filter(
        Boolean,
      ).length
      rules.push({
        id,
        action,
        tool,
        commandPrefix,
        pathGlob,
        access,
        reason,
        source,
        inputIndex: index,
        specificity,
      })
    })
  }
  return {
    rules,
    diagnostics: {
      loaded: rules.length,
      invalid: invalidRules.length,
      invalidRules,
    },
  }
}

function resolvePermissionRuleLayers(
  layers: PermissionRuleLayerInput[],
): PermissionRuleLayerInput[] {
  type IndexedLayer = { index: number; layer: PermissionRuleLayerInput }
  const key = defineConfigKey<IndexedLayer[]>({
    id: 'permissions.rules',
    builtin: [],
    merge: (current, next) => [...current, ...next.value],
    restrictUntrustedProject: (current, next) => [
      ...current,
      ...next.value.map((item) => ({
        index: item.index,
        layer: {
          source: { ...item.layer.source },
          rules: item.layer.rules.filter(
            (rule) => safeAction(rule?.action) !== 'allow',
          ),
        },
      })),
    ],
  })
  const candidates: ConfigCandidate<IndexedLayer[]>[] = layers.map(
    (layer, index) => ({
      source: permissionConfigSource(layer.source, index),
      value: [{ index, layer }],
    }),
  )
  return new ConfigResolver()
    .resolve(key, { candidates })
    .value.sort((left, right) => left.index - right.index)
    .map((item) => item.layer)
}

function permissionConfigSource(
  source: PermissionRuleSource,
  index: number,
): {
  kind: ConfigLayerKind
  id: string
  trust: ConfigSourceTrust
} {
  const id = safeSourcePart(source?.id, `permission-layer-${index}`)
  if (source?.trust === 'system')
    return { kind: 'builtin', id, trust: 'trusted' }
  if (source?.trust === 'managed')
    return { kind: 'managed', id, trust: 'managed' }
  if (source?.trust === 'user') return { kind: 'user', id, trust: 'trusted' }
  if (source?.trust === 'runtime')
    return { kind: 'session', id, trust: 'trusted' }
  if (source?.trust === 'project')
    return { kind: 'project', id, trust: 'trusted' }
  return { kind: 'project', id, trust: 'untrusted' }
}

export function matchPermissionRule(
  rules: PermissionRule[],
  profile: ToolPermissionProfile,
): PermissionRule | null {
  return resolvePermissionRules(rules, profile).winner
}

export function resolvePermissionRules(
  rules: PermissionRule[],
  profile: ToolPermissionProfile,
): PermissionRuleResolution {
  const evaluated = rules.map((rule) => ({
    rule,
    matched: ruleMatches(rule, profile),
  }))
  evaluated.sort((left, right) => {
    if (left.matched !== right.matched) return left.matched ? -1 : 1
    return compareRulePrecedence(left.rule, right.rule)
  })
  return {
    winner: evaluated.find((item) => item.matched)?.rule ?? null,
    candidates: evaluated.map(({ rule, matched }) => ({
      id: rule.id,
      action: rule.action,
      matched,
      source: { ...rule.source },
      precedence: precedenceLabel(rule),
    })),
  }
}

function ruleMatches(
  rule: PermissionRule,
  profile: ToolPermissionProfile,
): boolean {
  if (rule.tool && rule.tool !== profile.name) return false
  if (rule.commandPrefix && !matchesCommandPrefix(rule, profile.command))
    return false
  if (
    rule.pathGlob &&
    !(profile.paths.length ? profile.paths : [profile.path ?? '']).some(
      (path) => matchesPathGlob(path, rule.pathGlob!),
    )
  )
    return false
  if (rule.access && rule.access !== accessForProfile(profile)) return false
  return true
}

function matchesCommandPrefix(rule: PermissionRule, command: string): boolean {
  const prefix = rule.commandPrefix.trim()
  if (!prefix) return true
  const analysis = analyzeShellCommandFailClosed(command)

  // An allow rule requires one positively understood simple command. Ask and
  // deny rules may conservatively match any parsed nested command or the raw
  // fallback, because they only tighten the result.
  if (rule.action === 'allow') {
    if (
      analysis.status !== 'parsed' ||
      analysis.features.length ||
      analysis.reasonCodes.length ||
      analysis.commands.length !== 1
    )
      return false
    const node = analysis.commands[0]!
    if (node.env.length || node.redirects.length || node.nested) return false
    return hasCommandBoundary(node.argv.join(' '), prefix)
  }

  if (hasCommandBoundary(command.trim(), prefix)) return true
  return analysis.commands.some((node) =>
    hasCommandBoundary(node.argv.join(' '), prefix),
  )
}

function hasCommandBoundary(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `)
}

function compareRulePrecedence(
  left: PermissionRule,
  right: PermissionRule,
): number {
  return (
    actionRank(right.action) - actionRank(left.action) ||
    trustRank(right.source.trust) - trustRank(left.source.trust) ||
    right.specificity - left.specificity ||
    left.inputIndex - right.inputIndex ||
    left.id.localeCompare(right.id)
  )
}

function precedenceLabel(rule: PermissionRule): string {
  return `${rule.action}:${rule.source.trust}:${rule.specificity}:${rule.inputIndex}`
}

function actionRank(action: PermissionRuleAction): number {
  if (action === 'deny') return 3
  if (action === 'ask') return 2
  return 1
}

function trustRank(trust: PermissionRuleTrust): number {
  if (trust === 'system') return 5
  if (trust === 'managed') return 4
  if (trust === 'user') return 3
  if (trust === 'project') return 2
  if (trust === 'runtime') return 1
  if (trust === 'untrusted') return 0
  return 0
}

function normalizeSource(source: PermissionRuleSource): PermissionRuleSource {
  const trust = String(source?.trust ?? 'unknown') as PermissionRuleTrust
  return {
    kind: safeSourcePart(source?.kind, 'unknown'),
    id: safeSourcePart(source?.id, 'unknown'),
    trust: [
      'system',
      'managed',
      'user',
      'project',
      'runtime',
      'untrusted',
      'unknown',
    ].includes(trust)
      ? trust
      : 'unknown',
  }
}

function safeSourcePart(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(text) ? text : fallback
}

function safeRuleId(value: unknown): string {
  const id = String(value ?? '').trim()
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) ? id : ''
}

function safeAction(value: unknown): PermissionRuleAction | null {
  const action = String(value ?? '')
    .trim()
    .toLowerCase()
  return action === 'allow' || action === 'ask' || action === 'deny'
    ? action
    : null
}

function accessForProfile(profile: ToolPermissionProfile): string {
  if (profile.readOnly) return 'read'
  if (profile.name === 'run_command') return 'execute'
  if (
    profile.name === 'write_file' ||
    profile.name === 'edit_file' ||
    profile.name === 'apply_patch' ||
    profile.name === 'delete_file' ||
    profile.name === 'rename_file'
  )
    return 'write'
  return profile.destructive ? 'mutate' : 'read'
}

function matchesPathGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\//, '')
  const pattern = glob.replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!pattern) return false
  if (pattern === normalized) return true
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
  }
  if (pattern.includes('*')) return globRegex(pattern).test(normalized)
  return false
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '[^/]*'
      return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch
    })
    .join('')
  return new RegExp(`^${escaped}$`)
}
