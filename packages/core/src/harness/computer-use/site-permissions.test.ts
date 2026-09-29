import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SITE_PERMISSIONS_FILE, SitePermissionStore } from './site-permissions'

describe('site permission store', () => {
  it('allows exact profile + origin + kind, expires, and revokes', () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-cu-site-'))
    let now = new Date('2026-09-24T01:00:00.000Z')
    const store = new SitePermissionStore(root, () => now)
    expect(store.allowed('temporary', 'https://meet.test', 'camera')).toBe(
      false,
    )
    store.allow({
      profileId: 'temporary',
      origin: 'https://meet.test/room/1',
      kind: 'camera',
    })
    store.allow({
      profileId: 'p_0123456789ab',
      origin: 'https://maps.test',
      kind: 'geolocation',
      minutes: 30,
    })
    expect(statSync(join(root, SITE_PERMISSIONS_FILE)).mode & 0o777).toBe(0o600)
    expect(
      store.allowed('temporary', 'https://meet.test/other', 'camera'),
    ).toBe(true)
    expect(store.allowed('temporary', 'https://meet.test', 'microphone')).toBe(
      false,
    )
    expect(store.allowed('temporary', 'http://meet.test', 'camera')).toBe(false)
    expect(store.allowed('p_0123456789ab', 'https://meet.test', 'camera')).toBe(
      false,
    )
    expect(
      store.allowed('p_0123456789ab', 'https://maps.test', 'geolocation'),
    ).toBe(true)
    now = new Date('2026-09-24T01:31:00.000Z')
    expect(
      store.allowed('p_0123456789ab', 'https://maps.test', 'geolocation'),
    ).toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(new SitePermissionStore(root, () => now).list()).toHaveLength(1)
    expect(store.revoke({ profileId: 'temporary' })).toBe(1)
    expect(store.list()).toEqual([])
    expect(() =>
      store.allow({
        profileId: 'temporary',
        origin: 'file:///etc',
        kind: 'camera',
      }),
    ).toThrow(/http\(s\) origin/)
  })
})
