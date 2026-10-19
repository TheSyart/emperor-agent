// SEC-08 (PLAN-V020, findings CORE-11 / CORE-33): one ContainmentPolicy and
// one Seatbelt / bwrap generator for Shell, MCP stdio servers, plugin hooks
// and the environment installer. Shell keeps allow-all reads and its write
// policy: against the profile it had before SEC-08 it only gains deny lines.
// No consumer falls back to running unconfined without saying so.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  seatbeltGuardArgs,
  seatbeltProfileArgs,
} from '../harness/sandbox/backend'
import {
  ContainmentBackend,
  containmentPolicyHash,
  seatbeltProfile,
  type ContainmentPolicy,
} from './policy'
import { GOLDEN_CASES, normalizeProfile, splitForms } from './testing'

const GOLDEN = join(__dirname, '__golden__')

function shellProfile(name: string): string {
  const c = GOLDEN_CASES[name]!
  return c.kind === 'guard'
    ? seatbeltGuardArgs(c.stateRoot!, c.home)[1]!
    : seatbeltProfileArgs(c.policy!, c.stateRoot, c.home)[1]!
}

/** `before` in order inside `after`; the forms `after` adds. */
function addedForms(before: string[], after: string[]): string[] {
  const added: string[] = []
  let cursor = 0
  for (const form of after) {
    if (cursor < before.length && before[cursor] === form) cursor += 1
    else added.push(form)
  }
  expect(cursor, 'every pre-SEC-08 form is kept, in order').toBe(before.length)
  return added
}

describe('Shell profile golden (SEC-08 test 7)', () => {
  for (const name of Object.keys(GOLDEN_CASES)) {
    it(`${name}: only deny lines are added to the pre-SEC-08 profile`, () => {
      const before = readFileSync(join(GOLDEN, `${name}.pre-sec08.sb`), 'utf8')
        .trim()
        .split('\n')
      const after = splitForms(normalizeProfile(shellProfile(name)))
      const added = addedForms(before, after)
      for (const form of added) expect(form).toMatch(/^\(deny /)
    })
  }
})

/** Policies of the other consumers over paths that do not exist. */
const HOME = '/fixture/home'
const STATE = '/fixture/home/.emperor'
const UNIFIED: Record<string, ContainmentPolicy> = {
  'mcp-user': {
    read: {
      allow: ['/fixture/ws', '/fixture/servers/notes'],
      deny: [STATE],
    },
    write: {
      allow: [
        '/fixture/ws',
        `${STATE}/mcp/cache/notes`,
        '/fixture/servers/notes/data',
      ],
      deny: [STATE],
    },
    network: 'allow',
    tempDir: `${STATE}/mcp/cache/notes`,
    toolchainReadOnly: [
      '/opt/homebrew',
      '/fixture/home/.nvm/versions/node/v22',
    ],
    ancestorsMetadata: true,
    fallback: 'ask-user',
    protectedPaths: { stateRoot: STATE, home: HOME, credentialReads: 'deny' },
    desktop: 'allow',
    deniedSocketDirs: [`${STATE}/run`],
  },
  'mcp-plugin': {
    read: {
      allow: [`${STATE}/plugins/cache/kit`],
      deny: [STATE],
    },
    write: {
      allow: [
        `${STATE}/workspace`,
        `${STATE}/plugins/data/kit`,
        `${STATE}/mcp/cache/kit-docs`,
      ],
      deny: [STATE],
    },
    network: 'allow',
    tempDir: `${STATE}/mcp/cache/kit-docs`,
    toolchainReadOnly: ['/opt/homebrew'],
    ancestorsMetadata: true,
    fallback: 'refuse',
    protectedPaths: { stateRoot: STATE, home: HOME, credentialReads: 'deny' },
    desktop: 'allow',
    deniedSocketDirs: [`${STATE}/run`],
  },
  'plugin-hook': {
    read: {
      allow: ['/fixture/project', `${STATE}/plugins/cache/kit`],
      deny: [STATE],
    },
    write: {
      allow: [`${STATE}/plugins/data/kit`, `${STATE}/plugins/tmp/kit`],
      deny: [STATE],
    },
    network: 'allow',
    tempDir: `${STATE}/plugins/tmp/kit`,
    toolchainReadOnly: ['/opt/homebrew'],
    ancestorsMetadata: true,
    fallback: 'refuse',
    protectedPaths: { stateRoot: STATE, home: HOME, credentialReads: 'deny' },
    desktop: 'deny',
    deniedSocketDirs: [`${STATE}/run`],
  },
  'environment-installer': {
    read: { allow: [], deny: [STATE] },
    write: {
      allow: [
        `${STATE}/environment/jobs/managed/plan`,
        `${STATE}/environment/tools/acme/managed-1`,
      ],
      deny: [STATE],
    },
    network: 'deny',
    tempDir: `${STATE}/environment/jobs/managed/plan/tmp`,
    toolchainReadOnly: ['/opt/homebrew'],
    ancestorsMetadata: true,
    fallback: 'refuse',
    protectedPaths: { stateRoot: STATE, home: HOME, credentialReads: 'deny' },
    desktop: 'deny',
    deniedSocketDirs: [`${STATE}/run`],
  },
}

describe('one generator for every consumer (golden)', () => {
  for (const [name, policy] of Object.entries(UNIFIED)) {
    it(`${name}: the profile text is locked`, () => {
      const file = join(GOLDEN, `${name}.sb`)
      const text = splitForms(seatbeltProfile(policy)).join('\n') + '\n'
      if (process.env.EMPEROR_UPDATE_GOLDEN === '1' || !existsSync(file))
        writeFileSync(file, text)
      expect(text).toBe(readFileSync(file, 'utf8'))
    })
  }

  it('reads are deny-by-default with the toolchain, grants and ancestor lstat allowed', () => {
    const forms = splitForms(seatbeltProfile(UNIFIED['mcp-user']!))
    expect(forms.slice(0, 4)).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny file-read*)',
      '(import "system.sb")',
    ])
    const text = forms.join('\n')
    expect(text).toContain('(subpath "/fixture/home/.nvm/versions/node/v22")')
    // The cache folder is inside the hidden Emperor Home and opened after it.
    const deny = forms.indexOf(
      '(deny file-read* (subpath "/fixture/home/.emperor"))',
    )
    const grant = forms.findIndex(
      (form) =>
        form.startsWith('(allow file-read*') &&
        form.includes('/mcp/cache/notes'),
    )
    expect(deny).toBeGreaterThan(0)
    expect(grant).toBeGreaterThan(deny)
    expect(text).toMatch(
      /\(allow file-read-metadata[^\n]*\(literal "\/fixture\/home"\)/,
    )
    // Protected paths stay closed whatever is granted before them.
    expect(forms.at(-1)).toMatch(/^\(deny file-write\* \(literal /)
  })

  it('the hash names the policy, not its spelling order', () => {
    const policy = UNIFIED['mcp-plugin']!
    const reordered: ContainmentPolicy = {
      ...policy,
      toolchainReadOnly: [...policy.toolchainReadOnly].reverse(),
    }
    expect(containmentPolicyHash(reordered)).toBe(containmentPolicyHash(policy))
    expect(containmentPolicyHash({ ...policy, network: 'deny' })).not.toBe(
      containmentPolicyHash(policy),
    )
    expect(containmentPolicyHash(policy)).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('no silent unsandboxed fallback', () => {
  const unavailable = () =>
    new ContainmentBackend({
      platform: 'darwin',
      probe: () => ({ ok: false, detail: 'mock: sandbox-exec is broken' }),
    })

  it('refuses a refuse-policy and says why', async () => {
    const prepared = await unavailable().contain(
      ['/bin/echo', 'hi'],
      UNIFIED['mcp-plugin']!,
    )
    expect(prepared.argv).toBeNull()
    expect(prepared.receipt).toMatchObject({
      backend: 'none',
      decision: 'refused',
      policyHash: containmentPolicyHash(UNIFIED['mcp-plugin']!),
    })
    expect(prepared.receipt.reason).toContain('mock: sandbox-exec is broken')
  })

  it('runs an ask-user policy unconfined only after the user said yes', async () => {
    const backend = unavailable()
    const policy = UNIFIED['mcp-user']!
    const refused = await backend.contain(['/bin/echo'], policy)
    expect(refused.receipt.decision).toBe('refused')
    const asked: string[] = []
    const denied = await backend.contain(['/bin/echo'], policy, {
      decide: async (reason) => {
        asked.push(reason)
        return false
      },
    })
    expect(denied.receipt.decision).toBe('refused')
    const allowed = await backend.contain(['/bin/echo'], policy, {
      decide: async () => true,
    })
    expect(allowed.argv).toEqual(['/bin/echo'])
    expect(allowed.receipt).toMatchObject({
      backend: 'none',
      decision: 'user-allowed-unsandboxed',
    })
    expect(allowed.env.TMPDIR).toBe(policy.tempDir)
    expect(asked[0]).toContain('mock: sandbox-exec is broken')
  })

  it.runIf(process.platform === 'darwin')(
    'contains through /usr/bin/sandbox-exec and sets the temp folder',
    async () => {
      const prepared = await new ContainmentBackend().contain(
        ['/bin/echo', 'hi'],
        UNIFIED['plugin-hook']!,
      )
      expect(prepared.argv?.[0]).toBe('/usr/bin/sandbox-exec')
      expect(prepared.argv?.slice(-2)).toEqual(['/bin/echo', 'hi'])
      expect(prepared.receipt).toMatchObject({
        backend: 'seatbelt',
        decision: 'contained',
      })
      expect(prepared.env).toMatchObject({
        TMPDIR: `${STATE}/plugins/tmp/kit`,
      })
    },
  )
})

describe('the old modules are adapters (SEC-08 acceptance)', () => {
  it('generates profiles in one place only', () => {
    const source = (path: string) =>
      readFileSync(join(__dirname, '..', path), 'utf8')
    for (const path of ['harness/sandbox/backend.ts']) {
      const text = source(path)
      expect(text, path).not.toMatch(/\((?:allow|deny|version) /)
      expect(text, path).not.toContain('--ro-bind')
      expect(text, path).not.toContain('--unshare')
    }
  })
})
