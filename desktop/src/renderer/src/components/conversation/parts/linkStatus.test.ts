import { describe, expect, it } from 'vitest'
import {
  createLinkStatusSource,
  linkStatusOf,
  type ResolvedLink,
} from './linkStatus'

const file = (tooltip: string): ResolvedLink => ({
  kind: 'project_file',
  available: true,
  tooltip,
})

describe('linkStatusOf', () => {
  it('reads what Core says about the target', () => {
    expect(linkStatusOf(file('/p/a.ts'))).toEqual({
      state: 'file',
      path: '/p/a.ts',
    })
    expect(linkStatusOf({ ...file('/p/docs'), directory: true })).toMatchObject(
      { state: 'directory' },
    )
    expect(
      linkStatusOf({ kind: 'external_file', available: false, tooltip: '/x' }),
    ).toEqual({ state: 'missing', path: '/x' })
    expect(
      linkStatusOf({ kind: 'web', available: true, tooltip: 'https://a' }),
    ).toBeNull()
  })
})

describe('createLinkStatusSource', () => {
  it('retains each real message identity when the same path occurs twice', async () => {
    const sources: Array<string | undefined> = []
    const source = createLinkStatusSource(async (href, messageId) => {
      sources.push(messageId)
      return file(href)
    })
    await source.status('a.ts', 'm1')
    await source.status('a.ts', 'm2')
    await source.status('a.ts', 'm1')
    expect(sources).toEqual(['m1', 'm2'])
  })
  it('retries a pending image when another link changes the shared generation', async () => {
    let release!: (value: string) => void
    let reads = 0
    const source = createLinkStatusSource(
      async (href) => file(href),
      async () => {
        reads++
        if (reads === 1)
          return new Promise<string>((resolve) => {
            release = resolve
          })
        return 'data:image/png;base64,new'
      },
    )
    const pending = source.image('sun.png')
    while (!release) await Promise.resolve()
    source.record('other.md', file('other.md'))
    release('data:image/png;base64,old')
    expect(await pending).toBeNull()
    expect(await source.image('sun.png')).toBe('data:image/png;base64,new')
    expect(reads).toBe(2)
  })
  it('only reads owned project images, caches previews and drops pending work on session refresh', async () => {
    const reads: string[] = []
    let release!: (value: ResolvedLink) => void
    const source = createLinkStatusSource(
      async (href) =>
        href === 'pending.png'
          ? new Promise<ResolvedLink>((r) => {
              release = r
            })
          : {
              ...file(href),
              kind: href === 'outside.png' ? 'external_file' : 'project_file',
              relativePath: href,
            },
      async (reference) => {
        if (reference.kind === 'external_file')
          throw new Error('reference_image_outside_workspace')
        reads.push(reference.tooltip)
        return 'data:image/png;base64,c3Vu'
      },
    )
    expect(await source.image('sun.png')).toBe('data:image/png;base64,c3Vu')
    await source.image('sun.png')
    expect(await source.image('outside.png')).toBeNull()
    const pending = source.image('pending.png')
    await Promise.resolve()
    source.refresh()
    release({ ...file('pending.png'), relativePath: 'pending.png' })
    expect(await pending).toBeNull()
    expect(reads).toEqual(['sun.png'])
  })
  it('resolves each link once until refreshed', async () => {
    const asked: string[] = []
    const source = createLinkStatusSource(async (href) => {
      asked.push(href)
      return file(`/p/${href}`)
    })
    await source.status('a.ts')
    await source.status('a.ts')
    expect(asked).toEqual(['a.ts'])
    const before = source.version.value
    source.refresh()
    expect(source.version.value).toBe(before + 1)
    await source.status('a.ts')
    expect(asked).toEqual(['a.ts', 'a.ts'])
  })

  it('keeps a status learned from a click, and treats failures as unknown', async () => {
    const source = createLinkStatusSource(async () => {
      throw new Error('workspace_project_required')
    })
    expect(await source.status('a.ts')).toBeNull()
    const before = source.version.value
    source.record('b.ts', {
      kind: 'project_file',
      available: false,
      tooltip: '/p/b.ts',
    })
    expect(source.version.value).toBe(before + 1)
    expect(await source.status('b.ts')).toEqual({
      state: 'missing',
      path: '/p/b.ts',
    })
  })

  it('asks Core a few links at a time', async () => {
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []
    const source = createLinkStatusSource(async (href) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => release.push(resolve))
      inFlight -= 1
      return file(href)
    })
    const all = Array.from({ length: 10 }, (_, index) =>
      source.status(`f${index}.ts`),
    )
    while (release.length || inFlight) {
      await Promise.resolve()
      release.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect((await Promise.all(all)).every(Boolean)).toBe(true)
    expect(peak).toBe(4)
  })
})
