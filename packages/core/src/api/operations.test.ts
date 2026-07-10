import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { SessionEntry } from '../sessions/store'
import { CORE_API_ROUTE_OPERATIONS, type CoreApi } from './core-api'
import {
  CORE_OPERATION_REGISTRY,
  coreOperationKeys,
  invokeCoreOperation,
  isCoreOperationKey,
  type CoreOperationArgs,
  type CoreOperationKey,
  type CoreOperationResult,
} from './operations'

describe('Core operation registry', () => {
  it('covers every public CoreApi route exactly once', () => {
    const routeKeys = CORE_API_ROUTE_OPERATIONS.map((entry) => entry.key).sort()

    expect(coreOperationKeys()).toHaveLength(81)
    expect(coreOperationKeys()).toEqual(routeKeys)
    expect(Object.keys(CORE_OPERATION_REGISTRY).sort()).toEqual(routeKeys)
  })

  it('uses exact Zod tuples for no-arg, optional, single, and multi-arg operations', () => {
    expect(CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([])).toEqual([])
    expect(() =>
      CORE_OPERATION_REGISTRY['memory.tokens'].args.parse([{}]),
    ).toThrow()

    expect(CORE_OPERATION_REGISTRY.bootstrap.args.parse([])).toEqual([])
    expect(
      CORE_OPERATION_REGISTRY.bootstrap.args.parse([{ sessionId: 's1' }]),
    ).toEqual([{ sessionId: 's1' }])
    expect(() => CORE_OPERATION_REGISTRY.bootstrap.args.parse(['s1'])).toThrow()

    expect(
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { title: 'New title' },
      ]),
    ).toEqual(['s1', { title: 'New title' }])
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse(['s1']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['sessions.rename'].args.parse([
        's1',
        { archived: 'yes' },
      ]),
    ).toThrow()
  })

  it('rejects malformed security-sensitive payloads before invoking CoreApi', () => {
    expect(() =>
      CORE_OPERATION_REGISTRY['attachments.save'].args.parse([
        { raw: 'not-bytes', name: 'a.txt', mime: 'text/plain' },
      ]),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['mcp.saveConfig'].args.parse(['echo pwned']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['desktopPet.setEnabled'].args.parse(['true']),
    ).toThrow()
    expect(() =>
      CORE_OPERATION_REGISTRY['chat.submit'].args.parse([
        {
          content: 'review',
          requestedSkills: [{ name: '../outside', source: 'slash' }],
        },
      ]),
    ).toThrow()
  })

  it('preserves forward-compatible MCP fields while validating known fields', () => {
    const parsed = CORE_OPERATION_REGISTRY['mcp.saveConfig'].args.parse([
      {
        servers: {
          alpha: {
            transport: 'stdio',
            command: 'node',
            args: ['server.mjs'],
            vendorOption: { mode: 'safe' },
            tool_overrides: {
              search: { read_only: true, vendorPolicy: 'audit' },
            },
          },
        },
        defaults: { read_only: true, vendorDefault: 'preserve' },
        vendorRoot: { revision: 3 },
      },
    ])

    expect(parsed[0]).toMatchObject({
      servers: {
        alpha: {
          vendorOption: { mode: 'safe' },
          tool_overrides: {
            search: { read_only: true, vendorPolicy: 'audit' },
          },
        },
      },
      defaults: { vendorDefault: 'preserve' },
      vendorRoot: { revision: 3 },
    })
  })

  it('accepts a zero transcript limit supported by SidechainTranscript', () => {
    expect(
      CORE_OPERATION_REGISTRY['tasks.transcript'].args.parse([
        'task_1',
        { offset: 0, limit: 0 },
      ]),
    ).toEqual(['task_1', { offset: 0, limit: 0 }])
  })

  it('rejects task transcript ids that can escape the task directory', () => {
    for (const taskId of [
      '../escape',
      '..',
      '.',
      'nested/task',
      'nested\\task',
    ]) {
      expect(() =>
        CORE_OPERATION_REGISTRY['tasks.transcript'].args.parse([taskId]),
      ).toThrow()
    }
  })

  it('invokes the fixed adapter instead of resolving a dotted property path', async () => {
    const rename = vi.fn(() => ({ id: 's1', title: 'Renamed' }))
    const api = { sessions: { rename } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'sessions.rename', ['s1', { title: 'Renamed' }]),
    ).resolves.toEqual({ id: 's1', title: 'Renamed' })
    expect(rename).toHaveBeenCalledWith('s1', { title: 'Renamed' })
  })

  it('maps schema failures to a safe operation argument error', async () => {
    const setEnabled = vi.fn()
    const api = { desktopPet: { setEnabled } } as unknown as CoreApi

    await expect(
      invokeCoreOperation(api, 'desktopPet.setEnabled', ['true']),
    ).rejects.toMatchObject({
      code: 'invalid_core_arguments',
      message: 'Invalid arguments for desktopPet.setEnabled',
    })
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('exposes a runtime operation-key guard without accepting arbitrary strings', () => {
    expect(isCoreOperationKey('hooks.getConfig')).toBe(true)
    expect(isCoreOperationKey('chat.__proto__')).toBe(false)
    expect(isCoreOperationKey('missing.operation')).toBe(false)
  })
})

const renameArgs: CoreOperationArgs<'sessions.rename'> = [
  's1',
  { title: 'Typed' },
]
expectTypeOf(renameArgs).toMatchTypeOf<
  [string, string | { title?: string | null; archived?: boolean | null }]
>()

type RenameResult = CoreOperationResult<'sessions.rename'>
expectTypeOf<Awaited<RenameResult>>().toEqualTypeOf<SessionEntry>()

type ToolResult = CoreOperationResult<'tools.readResult'>
expectTypeOf<Awaited<ToolResult>>().toEqualTypeOf<{ content: string }>()

expectTypeOf<
  (typeof CORE_API_ROUTE_OPERATIONS)[number]['key']
>().toEqualTypeOf<CoreOperationKey>()

// @ts-expect-error operation keys are a closed union
const invalidKeyArgs: CoreOperationArgs<'missing.operation'> = []
void invalidKeyArgs

// @ts-expect-error sessions.rename requires a patch argument
const invalidRenameArgs: CoreOperationArgs<'sessions.rename'> = ['s1']
void invalidRenameArgs
