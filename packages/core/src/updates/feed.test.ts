import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  parseAppVersion,
  releaseChannelOf,
  versionChannel,
} from './version'
import {
  electronReference,
  parseChecksums,
  parseReleases,
  selectUpdate,
  type FeedRelease,
} from './feed'
import { UpdateUrlPolicy } from './http'

// REL-02: what counts as a newer version on which channel, which assets a
// release must have, and the SHA256SUMS.txt / Electron marker formats that
// REL-05's release pipeline writes.

const GITHUB = 'https://github.com/TheSyart/emperor-agent/releases/download'

function release(
  tag: string,
  options: {
    prerelease?: boolean
    draft?: boolean
    assets?: string[]
    body?: string
  } = {},
): Record<string, unknown> {
  const version = tag.slice(1)
  const preview = tag.includes('-preview.')
  const names = options.assets ?? [
    `Emperor-Agent-${version}${preview ? '-UNSIGNED-PREVIEW' : ''}-macos-arm64.dmg`,
    `Emperor-Agent-${version}${preview ? '-UNSIGNED-PREVIEW' : ''}-macos-x64.dmg`,
    'SHA256SUMS.txt',
  ]
  return {
    tag_name: tag,
    name: `Emperor Agent ${tag}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? preview,
    html_url: `https://github.com/TheSyart/emperor-agent/releases/tag/${tag}`,
    published_at: '2026-10-21T08:00:00Z',
    body: options.body ?? '',
    assets: names.map((name, index) => ({
      name,
      size: 1000 + index,
      browser_download_url: `${GITHUB}/${tag}/${name}`,
    })),
  }
}

const policy = new UpdateUrlPolicy(null)

function parsed(...items: Record<string, unknown>[]): FeedRelease[] {
  return parseReleases(items, { policy })
}

describe('versions and channels', () => {
  it('orders x.y.z, then a preview below its own stable', () => {
    const order = [
      '0.1.0-preview.4',
      '0.1.0',
      '0.2.0-preview.1',
      '0.2.0-preview.2',
      '0.2.0-preview.10',
      '0.2.0',
      '0.2.1',
      '0.10.0',
    ]
    for (let i = 1; i < order.length; i += 1)
      expect(
        compareVersions(
          parseAppVersion(order[i - 1]!)!,
          parseAppVersion(order[i]!)!,
        ),
        `${order[i - 1]} < ${order[i]}`,
      ).toBeLessThan(0)
    expect(
      compareVersions(parseAppVersion('0.2.0')!, parseAppVersion('0.2.0')!),
    ).toBe(0)
  })

  it('reads the channel from the version: a prerelease is a preview build', () => {
    expect(versionChannel(parseAppVersion('0.2.0')!)).toBe('stable')
    expect(versionChannel(parseAppVersion('0.2.0-preview.3')!)).toBe('preview')
    expect(versionChannel(parseAppVersion('0.2.0-test')!)).toBe('preview')
    expect(parseAppVersion('v0.2.0')).toBeNull()
    expect(parseAppVersion('0.2')).toBeNull()
    expect(parseAppVersion('0.2.0-preview.x y')).toBeNull()
  })

  it('takes only the two release tag forms: vX.Y.Z and vX.Y.Z-preview.N', () => {
    expect(releaseChannelOf('v0.2.1')?.channel).toBe('stable')
    expect(releaseChannelOf('v0.2.1-preview.2')?.channel).toBe('preview')
    expect(releaseChannelOf('v0.2.1-rc.1')).toBeNull()
    expect(releaseChannelOf('0.2.1')).toBeNull()
    expect(releaseChannelOf('v0.2.1-preview.')).toBeNull()
  })
})

describe('the release list', () => {
  it('3 · a stable build sees stable releases only; a preview build sees both', () => {
    const feed = parsed(
      release('v0.3.0-preview.1'),
      release('v0.2.1'),
      release('v0.2.0'),
    )
    expect(selectUpdate(feed, '0.2.0', 'arm64')?.version).toBe('0.2.1')
    expect(selectUpdate(feed, '0.2.0-preview.4', 'arm64')?.version).toBe(
      '0.3.0-preview.1',
    )
    expect(selectUpdate(feed, '0.3.0-preview.1', 'arm64')).toBeNull()
    // A stable release outranks the previews of the same version.
    const stableOverPreview = parsed(
      release('v0.2.1-preview.3'),
      release('v0.2.1'),
    )
    expect(
      selectUpdate(stableOverPreview, '0.2.1-preview.2', 'arm64')?.version,
    ).toBe('0.2.1')
    // Previews only: nothing for a stable build.
    expect(
      selectUpdate(parsed(release('v0.2.1-preview.1')), '0.2.0', 'arm64'),
    ).toBeNull()
  })

  it('2 · the same version or an older one is no update', () => {
    const feed = parsed(release('v0.2.0'), release('v0.1.9'))
    expect(selectUpdate(feed, '0.2.0', 'arm64')).toBeNull()
    expect(selectUpdate(feed, '0.2.1', 'arm64')).toBeNull()
  })

  it('1 · picks the highest newer release with this Mac’s DMG and SHA256SUMS.txt', () => {
    const feed = parsed(
      // Newest, but still uploading: no SHA256SUMS.txt yet.
      release('v0.2.2', {
        assets: ['Emperor-Agent-0.2.2-macos-arm64.dmg'],
      }),
      release('v0.2.1'),
    )
    const update = selectUpdate(feed, '0.2.0', 'arm64')!
    expect(update).toMatchObject({
      version: '0.2.1',
      tag: 'v0.2.1',
      channel: 'stable',
      notesUrl: 'https://github.com/TheSyart/emperor-agent/releases/tag/v0.2.1',
      asset: { name: 'Emperor-Agent-0.2.1-macos-arm64.dmg', size: 1000 },
    })
    expect(update.assetUrl).toBe(
      `${GITHUB}/v0.2.1/Emperor-Agent-0.2.1-macos-arm64.dmg`,
    )
    expect(update.checksumsUrl).toBe(`${GITHUB}/v0.2.1/SHA256SUMS.txt`)
    expect(selectUpdate(feed, '0.2.0', 'x64')?.asset.name).toBe(
      'Emperor-Agent-0.2.1-macos-x64.dmg',
    )
    // Preview packages carry UNSIGNED-PREVIEW in their names.
    expect(
      selectUpdate(
        parsed(release('v0.2.1-preview.1')),
        '0.2.0-preview.9',
        'arm64',
      )?.asset.name,
    ).toBe('Emperor-Agent-0.2.1-preview.1-UNSIGNED-PREVIEW-macos-arm64.dmg')
  })

  it('skips drafts, odd tags, a stable tag marked pre-release and junk entries', () => {
    const feed = parsed(
      release('v0.9.0', { draft: true }),
      release('v0.8.0', { prerelease: true }),
      release('v0.7.0-rc.1'),
      { tag_name: 42 },
      null as unknown as Record<string, unknown>,
      release('v0.2.1'),
    )
    expect(feed.map((item) => item.tag)).toEqual(['v0.2.1'])
  })

  it('refuses asset links outside the repository’s own release downloads', () => {
    const forged = release('v0.2.1')
    const assets = forged.assets as Array<Record<string, unknown>>
    assets[0]!.browser_download_url =
      'https://evil.example/Emperor-Agent-0.2.1-macos-arm64.dmg'
    expect(selectUpdate(parsed(forged), '0.2.0', 'arm64')).toBeNull()
    const otherRepo = release('v0.2.1')
    ;(
      otherRepo.assets as Array<Record<string, unknown>>
    )[0]!.browser_download_url =
      'https://github.com/someone/else/releases/download/v0.2.1/Emperor-Agent-0.2.1-macos-arm64.dmg'
    expect(selectUpdate(parsed(otherRepo), '0.2.0', 'arm64')).toBeNull()
    const plainHttp = release('v0.2.1')
    ;(
      plainHttp.assets as Array<Record<string, unknown>>
    )[0]!.browser_download_url =
      `${GITHUB.replace('https:', 'http:')}/v0.2.1/Emperor-Agent-0.2.1-macos-arm64.dmg`
    expect(selectUpdate(parsed(plainHttp), '0.2.0', 'arm64')).toBeNull()
  })

  it('reads the bundled Electron from the release marker; the newest is the reference', () => {
    const feed = parsed(
      release('v0.3.0', {
        body: 'notes\n<!-- emperor-release electron=45.1.0 -->',
      }),
      release('v0.2.1', { body: '<!-- emperor-release electron=43.0.2 -->' }),
      release('v0.2.0', { body: 'Electron 99.0.0 is mentioned in prose only' }),
    )
    expect(feed.map((item) => item.electron)).toEqual([
      '45.1.0',
      '43.0.2',
      null,
    ])
    expect(electronReference(feed)).toBe('45.1.0')
    expect(electronReference(parsed(release('v0.2.1')))).toBeNull()
  })
})

describe('SHA256SUMS.txt', () => {
  const hex = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  it('reads `<sha256>  <file>` lines, binary markers and ./ prefixes', () => {
    const sums = parseChecksums(
      [
        `${hex}  Emperor-Agent-0.2.1-macos-arm64.dmg`,
        `${other} *Emperor-Agent-0.2.1-macos-x64.dmg`,
        `${'C'.repeat(64)}  ./release-manifest.json`,
        '',
        '# comment',
        'not a line',
      ].join('\n'),
    )
    expect(sums.get('Emperor-Agent-0.2.1-macos-arm64.dmg')).toBe(hex)
    expect(sums.get('Emperor-Agent-0.2.1-macos-x64.dmg')).toBe(other)
    expect(sums.get('release-manifest.json')).toBe('c'.repeat(64))
    expect(sums.size).toBe(3)
  })

  it('treats a file listed twice with different digests as having none', () => {
    const sums = parseChecksums(
      `${hex}  a.dmg\n${other}  a.dmg\n${hex}  b.dmg\n${hex}  b.dmg\n`,
    )
    expect(sums.has('a.dmg')).toBe(false)
    expect(sums.get('b.dmg')).toBe(hex)
  })
})
