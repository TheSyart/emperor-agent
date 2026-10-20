/**
 * Installing a catalog entry (the 推荐 block of 能力; UI-S08 folded 探索 in).
 * 「安装」 never installs by itself; it opens the flow the 能力 tabs use,
 * prefilled, and the person confirms there:
 * - Skill  → SkillImportDialog on its URL tab (`skills.import` url source);
 * - MCP    → McpAddDialog with the entry's JSON (dry-run preview, then 导入);
 * - Plugin → PluginInstallDialog on the URL (`plugins.inspect` → preview →
 *   `plugins.install`); URL Plugins stay inactive until their signature
 *   verifies.
 * The component renders the three dialogs bound to what this returns.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { listSkills } from '../../../api/skills'
import type { McpImportResult } from '../../../api/mcp'
import { useAppContext } from '../../../composables/useAppContext'
import { useSession } from '../../../composables/useSession'
import type { BootstrapPayload } from '../../../types'
import { mcpImportSummary } from '../../settings/mcp/mcpModel'
import { usePluginInstall } from '../../settings/plugins/pluginInstall'
import {
  skillImportToast,
  skillProject,
  skillScopeOptions,
  skillSessionId,
  type SkillImportSummary,
} from '../../settings/skills/skillsModel'
import {
  exploreEntryInstalled,
  mcpEntryConfigText,
  type ExploreEntry,
} from './exploreModel'

export function useExploreInstall() {
  const ctx = useAppContext()
  const sessions = useSession()
  const router = useRouter()

  const installedState = computed(() => ({
    skills: (ctx.boot.value?.skills ?? []).map((skill) => skill.name),
    mcpServers: (ctx.boot.value?.mcp?.servers ?? []).map(
      (server) => server.serverName,
    ),
  }))

  // ── Skill: URL import ──────────────────────────────────────────────────
  const skillOpen = ref(false)
  const skillUrl = ref('')
  const sessionId = computed(() => skillSessionId(ctx.sessionId.value))
  const scopeOptions = computed(() =>
    skillScopeOptions(
      skillProject(
        sessions.sessions.value.find(
          (session) => session.id === ctx.sessionId.value,
        ),
      ),
    ),
  )

  // ── MCP: prefilled add dialog ──────────────────────────────────────────
  const mcpOpen = ref(false)
  const mcpText = ref('')

  // ── Plugin: URL inspect → install ──────────────────────────────────────
  const pluginFlow = usePluginInstall({
    onInstalled: async (preview) => {
      ctx.showToast(`已安装「${preview.name}」（签名验证通过前不会激活）`)
      await ctx.refreshAll()
    },
  })

  function installed(entry: ExploreEntry): boolean {
    return exploreEntryInstalled(entry, installedState.value)
  }

  function install(entry: ExploreEntry): void {
    const source = entry.install
    if ('skillUrl' in source) {
      skillUrl.value = source.skillUrl
      skillOpen.value = true
    } else if ('mcpConfig' in source) {
      mcpText.value = mcpEntryConfigText(entry)
      mcpOpen.value = true
    } else {
      pluginFlow.openUrl(source.pluginUrl)
    }
  }

  async function reloadSkills(): Promise<void> {
    const result = await listSkills({ sessionId: sessionId.value })
    const boot = ctx.boot.value
    if (!boot) return
    boot.skills = result.skills
    boot.invalidSkills = result.invalid
  }

  function onSkillImported(summary: SkillImportSummary): void {
    ctx.showToast(skillImportToast(summary))
    void ctx.runSafely(reloadSkills)
  }

  function viewSkill(name: string): void {
    void router.push({ path: '/capabilities/skills', query: { skill: name } })
  }

  function onMcpImported(result: McpImportResult): void {
    if (ctx.boot.value && result.status)
      ctx.boot.value.mcp = result.status as BootstrapPayload['mcp']
    ctx.showToast(mcpImportSummary(result))
  }

  return {
    installed,
    install,
    skillOpen,
    skillUrl,
    sessionId,
    scopeOptions,
    mcpOpen,
    mcpText,
    pluginFlow,
    onSkillImported,
    viewSkill,
    onMcpImported,
  }
}
