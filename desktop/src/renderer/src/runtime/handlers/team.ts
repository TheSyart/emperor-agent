import type { BootstrapPayload, WsEvent } from '../../types'

export function applyTeamEventToBootstrap(
  boot: BootstrapPayload,
  data: WsEvent,
  options: { countUnread?: boolean } = {},
) {
  boot.team ||= { members: [], leadInbox: [], leadUnread: 0, config: { members: [] } }

  if (data.event === 'team_member_update' && data.member) {
    const index = boot.team.members.findIndex((member) => member.name === data.member!.name)
    if (index >= 0) {
      boot.team.members[index] = { ...boot.team.members[index], ...data.member }
    } else {
      boot.team.members.push(data.member)
    }
    if (boot.team.config) boot.team.config.members = boot.team.members
    return
  }

  if (data.event !== 'team_message' || !data.message) return
  const countUnread = options.countUnread !== false

  if (data.message.to === 'lead') {
    boot.team.leadInbox ||= []
    let added = false
    if (!boot.team.leadInbox.some((msg) => msg.id === data.message!.id)) {
      boot.team.leadInbox.push(data.message)
      boot.team.leadInbox = boot.team.leadInbox.slice(-50)
      added = true
    }
    if (added && countUnread) boot.team.leadUnread = (boot.team.leadUnread || 0) + 1
  }

  const target = boot.team.members.find((member) => member.name === data.message!.to)
  if (target) {
    target.recent_messages ||= []
    let added = false
    if (!target.recent_messages.some((msg) => msg.id === data.message!.id)) {
      target.recent_messages.push(data.message)
      target.recent_messages = target.recent_messages.slice(-5)
      added = true
    }
    if (added && countUnread) target.unread = (target.unread || 0) + 1
  }
}
