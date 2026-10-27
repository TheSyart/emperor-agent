/**
 * A contact's avatar as ui/Avatar draws it (GRP-04): a library portrait on
 * its round tint, a subagent plush head, the vendor mark of Claude Code or
 * Codex, or — until the mascot's portraits ship (BRD-03) — Emperor's first
 * letter on a colour tile.
 */
import type { ContactAvatar } from '@emperor/core/api'
import { SUBAGENT_PORTRAITS } from '../ui/subagentPortraits'

export interface ContactAvatarProps {
  kind: 'library' | 'sprite' | 'logo' | 'color'
  id?: string
  frameId?: string
  iconId?: string
  label: string
}

const BACKEND_ICONS: Readonly<Record<string, string>> = {
  'claude-code': 'claude_code',
  codex: 'codex',
}

export function contactAvatarProps(
  avatar: ContactAvatar,
  name: string,
): ContactAvatarProps {
  switch (avatar.kind) {
    case 'library':
      return { kind: 'library', id: avatar.id, label: name }
    case 'portrait': {
      const frame = SUBAGENT_PORTRAITS[avatar.index]
      return frame
        ? { kind: 'sprite', frameId: frame.id, label: name }
        : { kind: 'color', id: name, label: name }
    }
    case 'logo':
      return {
        kind: 'logo',
        iconId: BACKEND_ICONS[avatar.backend],
        label: name,
      }
    default:
      return { kind: 'color', id: name, label: name }
  }
}
