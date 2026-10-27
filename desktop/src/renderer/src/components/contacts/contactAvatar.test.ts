// A contact's avatar as Avatar draws it; Emperor wears the mascot's crowned
// head (BRD-04).
import { describe, expect, it } from 'vitest'
import { contactAvatarProps } from './contactAvatar'

describe('contactAvatarProps', () => {
  it('draws Emperor as the mascot’s crowned head', () => {
    expect(
      contactAvatarProps({ kind: 'mascot', pose: 'crown-head' }, 'Emperor'),
    ).toEqual({ kind: 'mascot', id: 'crown-head', label: 'Emperor' })
  })

  it('keeps library portraits and vendor logos as they were', () => {
    expect(
      contactAvatarProps({ kind: 'library', id: 'AV-01-1' }, '架构师'),
    ).toEqual({ kind: 'library', id: 'AV-01-1', label: '架构师' })
    expect(
      contactAvatarProps({ kind: 'logo', backend: 'codex' }, 'Codex'),
    ).toMatchObject({ kind: 'logo', iconId: 'codex' })
  })
})
