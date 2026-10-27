/**
 * The group charter (GRP-06): the system-prompt section a member reads
 * after its job card — the group, its notice, who is in it, the rules in
 * force and how to talk. Deterministic for a given state.
 */
import type { GroupState } from './events'
import type { ContactId, GroupMember } from './types'

export function groupCharter(
  state: GroupState,
  roster: readonly GroupMember[],
  self: ContactId,
): string {
  const me = roster.find((m) => m.id === self)
  const members = state.members
    .map((id) => roster.find((m) => m.id === id))
    .filter((m): m is GroupMember => Boolean(m))
    .map((m) => {
      const role =
        m.id === state.moderator ? '（主持人）' : m.external ? '（外部）' : ''
      return `- ${m.name}${role}：${m.intro}`
    })
  const rule = state.settings.quiet
    ? '安静模式：只有被 @ 的成员发言。'
    : state.settings.collaboration === 'moderated'
      ? '主持人审核：没人被 @ 时由主持人安排谁发言；你点名别人或交办任务，要先经主持人批准。'
      : '自主：没人被 @ 时，和自己职责有关的成员举手发言；成员之间可以直接点名、直接交办。'
  const tools = me?.external
    ? ['- 要请别人接着说，在回答里写「@名字」。']
    : [
        '- 要请别人接着说，在回答里写「@名字」；不点名，就表示这条线你说完了。',
        '- 只想让某一位看到，用私信工具；布置一件有交付物的事，用交办工具。',
        '- 没有要补充的，用「没有补充」工具，不要为了礼貌重复别人说过的话。',
      ]
  return [
    `# 群聊：${state.title}`,
    '',
    `你是「${me?.name ?? self}」，在这个群里和其他成员一起工作，用户随时会插话。`,
    '',
    '## 群公告',
    state.charter.trim() || '（无）',
    '',
    '## 成员',
    ...members,
    '',
    '## 协作方式',
    rule,
    '',
    '## 怎么说话',
    ...tools,
    '- 你只会收到公开的消息和发给你的私信；别人之间的私信你看不到。',
    '- 用户能看到群里所有的消息，包括私信。',
  ].join('\n')
}
