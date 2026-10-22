/**
 * Shell profile golden cases (SEC-08): fixed policies over paths that do not
 * exist, so the profile text depends only on the generator. The user's home
 * folder and temp folder (the Emperor socket directories) are replaced by
 * placeholders.
 */
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type { SandboxPolicy } from '../harness/sandbox/policy'

export interface GoldenCase {
  kind: 'confine' | 'guard'
  policy?: SandboxPolicy
  stateRoot?: string
  home?: string
}

const HOME = '/fixture/home'
const STATE = '/fixture/home/.emperor'

export const GOLDEN_CASES: Record<string, GoldenCase> = {
  'shell-read-only': {
    kind: 'confine',
    policy: { mode: 'read-only', workspaceRoot: '/fixture/ws' },
  },
  'shell-workspace-write': {
    kind: 'confine',
    policy: { mode: 'workspace-write', workspaceRoot: '/fixture/ws' },
    stateRoot: STATE,
    home: HOME,
  },
  'shell-read-only-protected': {
    kind: 'confine',
    policy: { mode: 'read-only', workspaceRoot: '/fixture/ws' },
    stateRoot: STATE,
    home: HOME,
  },
  'shell-full-access-guard': { kind: 'guard', stateRoot: STATE, home: HOME },
  'delegation-read-only': {
    kind: 'confine',
    policy: {
      mode: 'read-only',
      workspaceRoot: '/fixture/ws',
      privateTempRoot: '/fixture/run/tmp',
      runtimeStateRoots: ['/fixture/run/codex-home'],
      readOnlyRoots: ['/fixture/ws/.git'],
      writableFiles: ['/fixture/home/.codex/auth.json'],
      processBoundaryTag: 'golden-tag',
    },
    stateRoot: STATE,
    home: HOME,
  },
  // AGT-12: a Claude Code run writes its own login and home under Emperor
  // Home (one folder for every run, the status check and 登录); the login
  // file is opened again after the credential table closes it.
  'delegation-claude-code': {
    kind: 'confine',
    policy: {
      mode: 'workspace-write',
      workspaceRoot: '/fixture/ws',
      privateTempRoot: `${STATE}/delegations/runtime/claude-default/dlg-1/tmp`,
      runtimeStateRoots: [
        `${STATE}/delegations/runtime/claude-default/dlg-1`,
        `${STATE}/delegations/claude-code/config`,
        `${STATE}/delegations/claude-code/home`,
      ],
      readOnlyRoots: ['/fixture/ws/.git'],
      writableFiles: [
        `${STATE}/delegations/claude-code/config/.credentials.json`,
      ],
    },
    stateRoot: STATE,
    home: HOME,
  },
  'delegation-workspace-write': {
    kind: 'confine',
    policy: {
      mode: 'workspace-write',
      workspaceRoot: '/fixture/ws',
      privateTempRoot: '/fixture/run/tmp',
    },
    stateRoot: STATE,
    home: HOME,
  },
}

function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Replace machine-specific folders with placeholders. */
export function normalizeProfile(profile: string): string {
  const uid = String(process.getuid?.() ?? 0)
  return profile
    .replaceAll(real(tmpdir()), '<TMPDIR>')
    .replaceAll(real(homedir()), '<USERHOME>')
    .replaceAll(`emperor-${uid}`, 'emperor-<UID>')
}

/** Top-level SBPL forms, one per entry. */
export function splitForms(profile: string): string[] {
  const forms: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let index = 0; index < profile.length; index += 1) {
    const char = profile[index]!
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '(') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) forms.push(profile.slice(start, index + 1))
    }
  }
  return forms
}
