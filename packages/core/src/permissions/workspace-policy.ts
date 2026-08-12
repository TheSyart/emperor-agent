import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import {
  canonicalizeExistingPath,
  isPathWithin,
  pathsEqual,
} from '../util/paths'

export type WorkspaceAccess = 'read' | 'write' | 'execute' | 'media'
export type OutsideWorkspaceBehavior = 'deny' | 'allow_read'

export interface WorkspaceRootSpec {
  path: string
  label?: string
}

export interface WorkspacePolicyOptions {
  workspaceRoot?: string | null
  stateRoot?: string | null
  allowRoots?: Array<string | WorkspaceRootSpec> | null
  denyRoots?: Array<string | WorkspaceRootSpec> | null
  readOnlyRoots?: Array<string | WorkspaceRootSpec> | null
  outsideWorkspace?: OutsideWorkspaceBehavior
}

export interface WorkspacePolicyExecutionContext {
  root?: string | null
  workspaceRoot?: string | null
  /** Host-derived scope for ordinary file tools; never accepted from model input. */
  fileExecutionScopes?: readonly FileExecutionScope[]
  /** Exact host-issued read authority; never accepted from model arguments. */
  fileAccessAuthorization?: FileAccessAuthorization | null
}

export interface FileAccessAuthorization {
  readonly version: 1
  readonly toolName: 'read_file' | 'glob' | 'grep'
  readonly operationFingerprint: string
  readonly canonicalPaths: readonly string[]
  readonly source: 'permission_rule' | 'user_approved_once' | 'full_access'
  readonly permissionMode: 'ask_before_edit' | 'smart_auto' | 'full_access'
  readonly authorizationId: string | null
}

export interface FileExecutionScope {
  readonly kind:
    'user_skill' | 'active_skill' | 'session_tool_result' | 'session_scratch'
  readonly root: string
  readonly skillName: string
  readonly access: 'read' | 'write'
}

export interface WorkspaceRootReceipt {
  path: string
  label: string
}

export interface WorkspacePathDecision {
  allowed: boolean
  access: WorkspaceAccess
  requestedPath: string
  resolvedPath: string
  realPath: string
  reason: string
  matchedRoot: WorkspaceRootReceipt | null
  allowedRoots: WorkspaceRootReceipt[]
  denyRoots: WorkspaceRootReceipt[]
  readOnlyRoots: WorkspaceRootReceipt[]
  outsideWorkspace: OutsideWorkspaceBehavior
}

interface ResolvedRoot extends WorkspaceRootReceipt {
  realPath: string
}

export class WorkspacePolicy {
  readonly workspaceRoot: string | null
  readonly stateRoot: string | null
  readonly outsideWorkspace: OutsideWorkspaceBehavior
  private readonly allowRootEntries: ResolvedRoot[]
  private readonly denyRootEntries: ResolvedRoot[]
  private readonly readOnlyRootEntries: ResolvedRoot[]

  constructor(opts: WorkspacePolicyOptions = {}) {
    this.workspaceRoot = normalizeRoot(opts.workspaceRoot)
    this.stateRoot = normalizeRoot(opts.stateRoot)
    this.outsideWorkspace = opts.outsideWorkspace ?? 'deny'
    const defaultAllow = this.workspaceRoot
      ? [{ path: this.workspaceRoot, label: 'workspace' }]
      : []
    const defaultDeny =
      this.stateRoot && this.stateRoot !== this.workspaceRoot
        ? [{ path: this.stateRoot, label: 'state' }]
        : []
    this.allowRootEntries = normalizeRoots(
      opts.allowRoots ?? defaultAllow,
      'workspace',
    )
    this.denyRootEntries = normalizeRoots(
      opts.denyRoots ?? defaultDeny,
      'denied',
    )
    this.readOnlyRootEntries = normalizeRoots(
      opts.readOnlyRoots ?? [],
      'read_only',
    )
  }

  resolvePath(
    rawPath: string,
    access: WorkspaceAccess,
    opts: { baseRoot?: string | null } = {},
  ): WorkspacePathDecision {
    const requestedPath = String(rawPath ?? '')
    const baseRoot = normalizeRoot(opts.baseRoot) ?? this.workspaceRoot
    const resolvedPath = resolveCandidatePath(requestedPath, baseRoot)
    const realPath = canonicalizeExistingPath(resolvedPath)
    const base = this.baseDecision(
      access,
      requestedPath,
      resolvedPath,
      realPath,
    )

    const denied = this.findRoot(this.denyRootEntries, resolvedPath, realPath)
    if (denied) {
      return {
        ...base,
        allowed: false,
        reason: `path is inside denied root: ${denied.path}`,
        matchedRoot: publicRoot(denied),
      }
    }

    const readOnly = this.findRoot(
      this.readOnlyRootEntries,
      resolvedPath,
      realPath,
    )
    if (readOnly && access !== 'read' && access !== 'media') {
      return {
        ...base,
        allowed: false,
        reason: `path is inside read-only root: ${readOnly.path}`,
        matchedRoot: publicRoot(readOnly),
      }
    }

    const allowed = this.findAllowedRoot(
      this.allowRootEntries,
      resolvedPath,
      realPath,
    )
    if (allowed) {
      return {
        ...base,
        allowed: true,
        reason: '',
        matchedRoot: publicRoot(allowed),
      }
    }

    if (this.outsideWorkspace === 'allow_read' && access === 'read') {
      return {
        ...base,
        allowed: true,
        reason: '',
        matchedRoot: null,
      }
    }

    return {
      ...base,
      allowed: false,
      reason: 'path is outside workspace',
      matchedRoot: null,
    }
  }

  describe(): Record<string, unknown> {
    return {
      workspaceRoot: this.workspaceRoot,
      stateRoot: this.stateRoot,
      allowRoots: this.allowRootEntries.map(publicRoot),
      denyRoots: this.denyRootEntries.map(publicRoot),
      readOnlyRoots: this.readOnlyRootEntries.map(publicRoot),
      outsideWorkspace: this.outsideWorkspace,
    }
  }

  private baseDecision(
    access: WorkspaceAccess,
    requestedPath: string,
    resolvedPath: string,
    realPath: string,
  ): WorkspacePathDecision {
    return {
      allowed: false,
      access,
      requestedPath,
      resolvedPath,
      realPath,
      reason: '',
      matchedRoot: null,
      allowedRoots: this.allowRootEntries.map(publicRoot),
      denyRoots: this.denyRootEntries.map(publicRoot),
      readOnlyRoots: this.readOnlyRootEntries.map(publicRoot),
      outsideWorkspace: this.outsideWorkspace,
    }
  }

  private findRoot(
    roots: ResolvedRoot[],
    resolvedPath: string,
    realPath: string,
  ): ResolvedRoot | null {
    return (
      roots.find(
        (root) =>
          isPathWithin(resolvedPath, root.path) ||
          isPathWithin(realPath, root.realPath),
      ) ?? null
    )
  }

  private findAllowedRoot(
    roots: ResolvedRoot[],
    resolvedPath: string,
    realPath: string,
  ): ResolvedRoot | null {
    return (
      roots.find(
        (root) =>
          isPathWithin(resolvedPath, root.path) &&
          isPathWithin(realPath, root.realPath),
      ) ?? null
    )
  }
}

export function workspacePolicyForTool(
  ctx: WorkspacePolicyExecutionContext | null | undefined,
  fallbackWorkspace: string | null,
  toolName?: FileAccessAuthorization['toolName'],
): WorkspacePolicy {
  const workspaceRoot =
    normalizeRoot(ctx?.workspaceRoot) ??
    normalizeRoot(ctx?.root) ??
    normalizeRoot(fallbackWorkspace)
  const root = normalizeRoot(ctx?.root)
  const scopes = validFileExecutionScopes(ctx?.fileExecutionScopes)
  const authorization = validFileAccessAuthorization(
    ctx?.fileAccessAuthorization,
    toolName,
  )
  if (scopes.length || authorization) {
    return new WorkspacePolicy({
      workspaceRoot,
      allowRoots: [
        ...(workspaceRoot ? [{ path: workspaceRoot, label: 'workspace' }] : []),
        ...scopes.map((scope) => ({
          path: scope.root,
          label: `${scope.kind}:${scope.skillName}`,
        })),
        ...(authorization?.canonicalPaths ?? []).map((path) => ({
          path,
          label: 'authorized_read',
        })),
      ],
      // A nested, host-issued Skill scope is more specific than stateRoot. The
      // rest of stateRoot remains outside all allow roots and therefore denied.
      denyRoots: [],
    })
  }
  const stateRoot =
    root && workspaceRoot && !pathsEqual(root, workspaceRoot) ? root : null
  return new WorkspacePolicy({ workspaceRoot, stateRoot })
}

function validFileAccessAuthorization(
  authorization: FileAccessAuthorization | null | undefined,
  toolName: FileAccessAuthorization['toolName'] | undefined,
): FileAccessAuthorization | null {
  if (
    !authorization ||
    authorization.version !== 1 ||
    !toolName ||
    authorization.toolName !== toolName ||
    !/^[a-f0-9]{64}$/.test(authorization.operationFingerprint) ||
    !authorization.canonicalPaths.length
  )
    return null
  const canonicalPaths = authorization.canonicalPaths
    .map((path) => normalizeRoot(path))
    .filter((path): path is string => Boolean(path))
  if (!canonicalPaths.length) return null
  return { ...authorization, canonicalPaths }
}

export function validFileExecutionScopes(
  scopes: readonly FileExecutionScope[] | null | undefined,
): FileExecutionScope[] {
  return (scopes ?? []).filter(
    (scope) =>
      (scope?.kind === 'user_skill' ||
        scope?.kind === 'active_skill' ||
        scope?.kind === 'session_tool_result' ||
        scope?.kind === 'session_scratch') &&
      Boolean(String(scope.root ?? '').trim()) &&
      Boolean(String(scope.skillName ?? '').trim()) &&
      (scope.access === 'read' || scope.access === 'write'),
  )
}

/**
 * Derive one narrow Skill subtree from final, prepared file-tool arguments.
 * The returned value is trusted runtime context, never part of a tool schema.
 */
export function deriveUserSkillFileScope(
  paths: readonly string[],
  userSkillsRoot: string | null | undefined,
  baseRoot: string | null | undefined,
): FileExecutionScope | null {
  const skillsRoot = normalizeRoot(userSkillsRoot)
  if (!skillsRoot) return null
  const realSkillsRoot = canonicalizeExistingPath(skillsRoot)
  let skillName: string | null = null
  for (const rawPath of paths) {
    const resolvedPath = resolveCandidatePath(
      String(rawPath ?? ''),
      baseRoot ?? null,
    )
    const realPath = canonicalizeExistingPath(resolvedPath)
    if (
      !isPathWithin(resolvedPath, skillsRoot) ||
      !isPathWithin(realPath, realSkillsRoot)
    )
      continue
    const segment = relative(skillsRoot, resolvedPath).split(sep)[0] ?? ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return null
    if (skillName !== null && skillName !== segment) return null
    skillName = segment
  }
  if (!skillName) return null
  return {
    kind: 'user_skill',
    root: join(skillsRoot, skillName),
    skillName,
    access: 'write',
  }
}

export function formatWorkspacePolicyError(
  decision: WorkspacePathDecision,
): string {
  const deniedRoot = decision.reason.includes('denied root')
  const prefix = deniedRoot
    ? '[ERR] path denied by workspace policy'
    : '[ERR] path is outside workspace'
  return [
    `${prefix}: ${decision.reason || 'blocked'}`,
    `requested: ${decision.requestedPath || '(empty)'}`,
    `resolved: ${decision.resolvedPath}`,
    `allowed_roots: ${formatRoots(decision.allowedRoots)}`,
    `denied_roots: ${formatRoots(decision.denyRoots)}`,
  ].join('; ')
}

export function isWithinWorkspaceRoot(path: string, root: string): boolean {
  return isPathWithin(
    canonicalizeExistingPath(resolve(path)),
    canonicalizeExistingPath(resolve(root)),
  )
}

function normalizeRoot(root: string | null | undefined): string | null {
  const value = String(root ?? '').trim()
  return value ? resolve(expandHome(value)) : null
}

function normalizeRoots(
  values: Array<string | WorkspaceRootSpec>,
  defaultLabel: string,
): ResolvedRoot[] {
  const out: ResolvedRoot[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const raw = typeof value === 'string' ? value : value.path
    const path = normalizeRoot(raw)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({
      path,
      realPath: canonicalizeExistingPath(path),
      label:
        typeof value === 'string' ? defaultLabel : value.label || defaultLabel,
    })
  }
  return out
}

function publicRoot(root: ResolvedRoot): WorkspaceRootReceipt {
  return { path: root.path, label: root.label }
}

function formatRoots(roots: WorkspaceRootReceipt[]): string {
  return roots.map((root) => root.path).join(', ') || '(none)'
}

function resolveCandidatePath(
  rawPath: string,
  baseRoot: string | null,
): string {
  const expanded = expandHome(normalize(String(rawPath || '.')))
  if (isAbsolute(expanded)) return resolve(expanded)
  return baseRoot ? resolve(baseRoot, expanded) : resolve(expanded)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}
