import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { portablePackage, writePackage } from '../plugins/testing'
import type { GhCommandRequest } from '../workspace/git-pull-requests'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { CoreApi } from './core-api'
import type { ReferencePreview } from '../public/api'
import {
  CORE_OPERATION_REGISTRY,
  invokeCoreOperation,
  type CoreOperationResult,
} from './operations'
import { makeApi, tmp } from './test-helpers'

const apis: CoreApi[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) await api.close()
})

async function setup() {
  const fixture = await makeApi()
  apis.push(fixture.api)
  return fixture
}

describe('reference preview application boundary', () => {
  it('exposes site icons only through readable, opaque session references', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Icons' }).id)
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: 'https://example.com',
      label: 'Example',
    })
    const args = CORE_OPERATION_REGISTRY['references.siteIcon'].args
    expect(() =>
      args.parse([
        {
          sessionId,
          referenceId: reference.id,
          href: 'https://forged.example',
        },
      ]),
    ).toThrow()
    expect(
      await invokeCoreOperation(api, 'references.siteIcon', [
        { sessionId, referenceId: reference.id },
      ]),
    ).toMatchObject({ state: 'unavailable', reason: 'network_unavailable' })
    expect(
      await api.references.siteIcon({ sessionId, referenceId: 'missing' }),
    ).toMatchObject({ reason: 'reference_unavailable' })
  })
  it('validates an opaque reference identity and rejects raw targets', () => {
    const registry = CORE_OPERATION_REGISTRY as unknown as Record<
      string,
      { args: { parse(input: unknown): unknown } }
    >
    expect(registry['references.preview']).toBeDefined()
    const args = registry['references.preview']!.args
    expect(args.parse([{ sessionId: 's1', referenceId: 'ref_1' }])).toEqual([
      { sessionId: 's1', referenceId: 'ref_1' },
    ])
    for (const input of [
      { sessionId: '', referenceId: 'ref_1' },
      { sessionId: 's1', referenceId: '' },
      {
        sessionId: 's1',
        referenceId: 'ref_1',
        href: 'https://forged.example/secret',
      },
      { sessionId: 's1', referenceId: 'ref_1', absolutePath: '/forged' },
    ])
      expect(() => args.parse([input])).toThrow()
    expectTypeOf<
      CoreOperationResult<'references.preview'>
    >().toEqualTypeOf<ReferencePreview>()
  })

  it('returns the same typed absence through direct and registered operations without changing transcript', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Preview' }).id)
    const reference = api.references.resolve({
      sessionId,
      sourceMessageId: 'm1',
      href: 'https://example.com/guide',
      label: 'Guide',
    })
    const before = api.host.sessionLog(sessionId)?.events.slice()
    const direct = await api.references.preview({
      sessionId,
      referenceId: reference.id,
    })
    const registered = await invokeCoreOperation(api, 'references.preview', [
      { sessionId, referenceId: reference.id },
    ])
    expect(direct).toMatchObject({
      state: 'unavailable',
      reason: 'network_unavailable',
    })
    expect(registered).toMatchObject({
      state: 'unavailable',
      reason: 'network_unavailable',
    })
    expect(api.host.sessionLog(sessionId)?.events).toEqual(before)
    api.sessions.create({ title: 'Retained' })
    await api.sessions.delete(sessionId)
    expect(
      await api.references.preview({ sessionId, referenceId: reference.id }),
    ).toMatchObject({ state: 'unavailable', reason: 'reference_unavailable' })
  })
})

describe('readable child reference ownership', () => {
  it('previews child references while the lineage root is readable and refuses archived roots', async () => {
    const { api } = await makeApi({
      replies: [
        {
          tools: [
            {
              id: 'd1',
              name: 'subagent',
              args: {
                description: 'research',
                prompt: 'find x',
                run_in_background: false,
              },
            },
          ],
        },
        { text: 'child found x' },
        { text: 'parent done' },
      ],
    })
    apis.push(api)
    const rootId = String(api.sessions.create({ title: 'Parent' }).id)
    await api.chat.submit({ content: 'delegate', sessionId: rootId })
    const childId = api.sessions.children({ sessionId: rootId })[0]!.subagentId
    expect(api.sessions.history({ sessionId: childId }).header.id).toBe(childId)
    const rootRef = api.references.resolve({
      sessionId: rootId,
      sourceMessageId: 'm1',
      href: 'https://example.com/root',
      label: 'Root',
    })
    const childRef = api.references.resolve({
      sessionId: childId,
      sourceMessageId: 'm2',
      href: 'https://example.com/child',
      label: 'Child',
    })
    expect(
      await api.references.preview({
        sessionId: rootId,
        referenceId: rootRef.id,
      }),
    ).toMatchObject({ reason: 'network_unavailable' })
    expect(
      await api.references.preview({
        sessionId: childId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'network_unavailable' })
    expect(
      await api.references.preview({
        sessionId: rootId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'reference_unavailable' })
    await api.sessions.rename(rootId, { archived: true })
    expect(
      await api.references.preview({
        sessionId: childId,
        referenceId: childRef.id,
      }),
    ).toMatchObject({ reason: 'reference_unavailable' })
  })
})

describe('Chat attachment references', () => {
  it('resolves a stored attachment without a Build project and binds Finder access to its readable session', async () => {
    const { api } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    const foreignSession = String(api.sessions.create({ title: 'Other' }).id)
    const attachment = api.attachments.save({
      raw: Buffer.from('private notes'),
      name: '报告 说明.md',
      mime: 'text/markdown',
    })
    const input = {
      sessionId,
      sourceMessageId: 'm1',
      href: `attachment:${attachment.id}`,
      label: attachment.name,
    }
    const reference = api.references.resolve(input)
    expect(reference).toMatchObject({
      kind: 'external_file',
      available: true,
      label: '报告 说明.md',
      actions: ['reveal', 'preview'],
    })
    expect(
      api.references.revealPath({ sessionId, referenceId: reference.id }),
    ).toBe(realpathSync(join(api.attachmentStore.root, attachment.rel_path)))
    expect(() =>
      api.references.revealPath({
        sessionId: foreignSession,
        referenceId: reference.id,
      }),
    ).toThrow()
    expect(() =>
      api.references.resolve({ ...input, sessionId: 'unknown-session' }),
    ).toThrow()
    expect(() =>
      api.references.resolve({ ...input, href: 'attachment:att_invalid' }),
    ).toThrow()
    expect(() =>
      api.references.resolve({
        ...input,
        href: 'attachment:att_2026-10_ffffffff',
      }),
    ).toThrow()
    rmSync(join(api.attachmentStore.root, attachment.rel_path))
    expect(api.references.resolve(input)).toMatchObject({
      available: false,
      actions: [],
    })
    expect(() =>
      api.references.revealPath({ sessionId, referenceId: reference.id }),
    ).toThrow()
  })

  it('rejects stored attachment traversal and symlinks outside the attachment directory', async () => {
    const { api, root } = await setup()
    const sessionId = String(api.sessions.create({ title: 'Chat' }).id)
    const attachment = api.attachments.save({
      raw: Buffer.from('notes'),
      name: 'notes.md',
      mime: 'text/markdown',
    })
    const original = attachment.rel_path
    const input = {
      sessionId,
      sourceMessageId: 'm1',
      href: `attachment:${attachment.id}`,
      label: 'Notes',
    }
    attachment.rel_path = '../outside.md'
    expect(() => api.references.resolve(input)).toThrow()
    attachment.rel_path = original
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    rmSync(join(api.attachmentStore.root, original))
    symlinkSync(outside, join(api.attachmentStore.root, original))
    expect(() => api.references.resolve(input)).toThrow()
  })
})

describe('GitHub reference preview integration', () => {
  it('uses current authenticated read methods and refuses cached access after plugin disable', async () => {
    const root = tmp('emperor-preview-github-')
    writePackage(
      join(root, 'bundled-plugins', 'github'),
      portablePackage('github'),
    )
    let account = 'alice'
    let authFailure = false
    const requests: GhCommandRequest[] = []
    const { api } = await makeApi({
      root,
      extra: {
        github: {
          resolveRuntime: async () => ({ executable: '/signed/gh', env: {} }),
          run: async (request) => {
            requests.push(request)
            if (authFailure)
              return {
                exitCode: 4,
                stdout: 'SECRET authentication detail',
                stderr: '',
              }
            const common = {
              number: 42,
              title: `Visible to ${account}`,
              body: 'PRIVATE BODY',
              state: 'OPEN',
              url: 'https://github.com/acme/app/pull/42',
              author: { login: account },
              repository: { nameWithOwner: 'acme/app' },
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-10-02T00:00:00Z',
            }
            const query =
              request.args.find((arg) => arg.startsWith('query=')) ?? ''
            const payload = query.includes('EmperorPullRequestView')
              ? {
                  data: {
                    repository: {
                      pullRequest: {
                        ...common,
                        isDraft: false,
                        headRefName: 'feature',
                        baseRefName: 'main',
                        additions: 1,
                        deletions: 0,
                        changedFiles: 1,
                        files: { nodes: [] },
                        commits: { totalCount: 1 },
                        headCommit: { nodes: [] },
                        reviewDecision: null,
                      },
                    },
                  },
                }
              : query.includes('EmperorIssueView')
                ? {
                    data: {
                      repository: {
                        issue: {
                          ...common,
                          url: 'https://github.com/acme/app/issues/42',
                          stateReason: null,
                          closedAt: null,
                          labels: { nodes: [] },
                          assignees: { nodes: [] },
                          comments: { totalCount: 0, nodes: [] },
                        },
                      },
                    },
                  }
                : request.args.some((arg) => arg.endsWith('/jobs'))
                  ? { total_count: 0, jobs: [] }
                  : {
                      id: 42,
                      name: 'CI',
                      display_title: `Build for ${account}`,
                      status: 'completed',
                      conclusion: 'success',
                      event: 'push',
                      head_branch: 'main',
                      run_number: 7,
                      created_at: '2026-10-01T00:00:00Z',
                      updated_at: '2026-10-02T00:00:00Z',
                      html_url: 'https://github.com/acme/app/actions/runs/42',
                      actor: { login: account },
                    }
            return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '' }
          },
        },
      },
    })
    apis.push(api)
    const sessionId = String(
      api.sessions.create({ title: 'GitHub previews' }).id,
    )
    const ref = (path: string) =>
      api.references.resolve({
        sessionId,
        sourceMessageId: 'm1',
        href: `https://github.com/acme/app/${path}`,
        label: 'GitHub',
      })
    const pull = ref('pull/42')
    expect(
      await api.references.preview({ sessionId, referenceId: pull.id }),
    ).toMatchObject({
      state: 'ready',
      title: 'Visible to alice',
      status: 'OPEN',
      description: 'acme/app #42 · alice',
    })
    account = 'bob'
    const changed = await invokeCoreOperation(api, 'references.preview', [
      { sessionId, referenceId: pull.id },
    ])
    expect(changed).toMatchObject({ state: 'ready', title: 'Visible to bob' })
    expect(JSON.stringify(changed)).not.toContain('PRIVATE BODY')
    expect(
      await api.references.preview({
        sessionId,
        referenceId: ref('issues/42').id,
      }),
    ).toMatchObject({ state: 'ready', title: 'Visible to bob', status: 'OPEN' })
    expect(
      await api.references.preview({
        sessionId,
        referenceId: ref('actions/runs/42').id,
      }),
    ).toMatchObject({
      state: 'ready',
      title: 'Build for bob',
      status: 'success',
    })
    expect(
      requests.every(
        (request) =>
          request.args[0] === 'api' && request.signal instanceof AbortSignal,
      ),
    ).toBe(true)
    authFailure = true
    const unavailable = await api.references.preview({
      sessionId,
      referenceId: pull.id,
    })
    expect(unavailable).toMatchObject({
      state: 'unavailable',
      reason: 'github_unauthenticated',
    })
    expect(JSON.stringify(unavailable)).not.toContain('SECRET')
    await api.plugins.setEnabled({
      pluginId: 'github',
      scope: 'managed',
      enabled: false,
    })
    const count = requests.length
    expect(
      await api.references.preview({ sessionId, referenceId: pull.id }),
    ).toMatchObject({ state: 'unavailable', reason: 'github_plugin_disabled' })
    expect(requests).toHaveLength(count)
  })
})
