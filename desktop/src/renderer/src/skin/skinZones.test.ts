/**
 * BRD-05 (D8): where a skin may not reach, and what it may cost.
 *
 * - Exempt zones — conversation text, code, diffs, permission cards, costs,
 *   sign-in and credential UI — bind useSkinExempt() on their root (or
 *   open their Modal with `exempt`), so every token a skin changes is back
 *   at the base theme's value there (card test 7; the pixel check is in
 *   tests/visual/skins.spec.ts).
 * - No decoration inside an exempt zone.
 * - Card test 11: the decorations' own styles stay under 2 KB, tokens are
 *   set at run time and no stylesheet is added to the global CSS.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = new URL('..', import.meta.url).pathname

const EXEMPT_ZONES: Record<string, string> = {
  // Conversation text, code blocks and diffs inside it, its cost rows.
  'components/conversation/ChatTimeline.vue': '对话正文',
  'components/conversation/ExternalAgentConversation.vue': '对话正文',
  'components/groups/GroupConversation.vue': '对话正文',
  // Code and diffs outside the conversation.
  'components/workspace/FilesPane.vue': '代码',
  'components/workspace/GitReviewPane.vue': '改动对比',
  'components/workspace/TurnReviewView.vue': '改动对比',
  'components/workspace/TerminalPane.vue': '代码',
  // Permission cards and confirmations.
  'components/conversation/takeover/ApprovalPanel.vue': '权限确认',
  'components/conversation/takeover/GrantPanel.vue': '权限确认',
  'components/ui/ConfirmHost.vue': '权限确认',
  // Costs.
  'components/settings/UsageCostSection.vue': '费用',
  'components/groups/GroupLiveBar.vue': '费用',
  'components/groups/GroupPage.vue': '费用',
  // Sign-in and credentials.
  'components/settings/ClaudeApiKeyDialog.vue': '登录与凭据',
  'components/settings/executors/ClaudeSignInNotice.vue': '登录与凭据',
  'components/settings/executors/ExecutorDetailPage.vue': '登录与凭据',
  'components/settings/model/ConnectionKeyDialog.vue': '登录与凭据',
  'components/settings/model/ConnectStep.vue': '登录与凭据',
  'components/settings/browser/PasswordManagerPage.vue': '登录与凭据',
  'components/settings/browser/SignInProfilesPage.vue': '登录与凭据',
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

function template(sfc: string): string {
  return /<template>([\s\S]*)<\/template>/.exec(sfc)?.[1] ?? ''
}

function styles(sfc: string): string {
  return [...sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join('\n')
}

describe('exempt zones (D8)', () => {
  it.each(Object.entries(EXEMPT_ZONES))(
    '%s keeps the base theme (%s)',
    (rel) => {
      const sfc = read(rel)
      const markup = template(sfc)
      const bound =
        (/useSkinExempt\(\)/.test(sfc) &&
          /:style="(?:\[[^\]]*)?exempt\b/.test(markup)) ||
        /<Modal\b[^>]*\sexempt[\s>]/.test(markup) ||
        /<SkinExempt\b/.test(markup)
      expect(bound, `${rel} binds no exempt style`).toBe(true)
    },
  )

  it('puts no decoration inside an exempt zone', () => {
    for (const rel of Object.keys(EXEMPT_ZONES))
      expect(read(rel), rel).not.toMatch(
        /<SkinSlot|<SkinStamp|SkinSlot\.vue|SkinStamp\.vue/,
      )
  })
})

describe('11 · what skins add to the styles', () => {
  it('keeps the decorations’ styles under 2 KB', () => {
    const own = readdirSync(join(SRC, 'skin'))
      .filter((name) => name.endsWith('.vue'))
      .map((name) => styles(read(join('skin', name))))
    const placed = [
      'components/conversation/EmptyHero.vue',
      'components/sidebar/SidebarRoot.vue',
      'components/conversation/ConversationView.vue',
    ].flatMap((rel) =>
      [...styles(read(rel)).matchAll(/[^{}]*skin[^{}]*\{[^{}]*\}/g)].map(
        (m) => m[0],
      ),
    )
    const bytes = Buffer.byteLength([...own, ...placed].join('\n'))
    expect(placed.length).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(2048)
  })

  it('sets tokens at run time and adds no global stylesheet', () => {
    const main = read('main.ts')
    expect(main).toContain("from './skin/skinState'")
    expect(main).not.toMatch(/import '\.\/skin\/.*\.css'/)
    // The one global addition: the heading font every skin may swap.
    expect(read('theme/primitives.css')).toMatch(
      /--font-heading: var\(--font-sans\);/,
    )
  })
})
