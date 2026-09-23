/**
 * 能力 › 插件 — install flow and display vocabulary.
 *
 * Every install is two Core calls: `plugins.inspect(source)` stages the
 * Plugin and returns a preview (id, version, digest, signature,
 * capabilities), and `plugins.install({ previewId, digest, scope })`
 * confirms exactly that staged content. Sources:
 * - local: a folder or a .zip on disk (`{ kind: 'local', path }`), picked
 *   through the main-process directory / file dialogs; recorded as a local
 *   user source and activated once enabled.
 * - url: an https archive (`{ kind: 'url', url }`). URL Plugins must pass
 *   signature verification before they activate; until then they install
 *   but stay 「签名未验证 · 未激活」 (activation `blocked_unverified`).
 */
import { computed, reactive } from 'vue'
import type { CoreOperationResult } from '@emperor/core/api'
import { selectDirectory, selectFile } from '../../../api/backend'
import { core } from '../../../api/http'

export type PluginSummary = CoreOperationResult<'plugins.list'>[number]
export type PluginPreview = CoreOperationResult<'plugins.inspect'>
export type PluginInstallScope = 'user' | 'project' | 'local'
export type PluginInstallStep = 'closed' | 'url' | 'preview'

export const PLUGIN_SCOPE_OPTIONS: ReadonlyArray<{
  value: PluginInstallScope
  label: string
  description: string
}> = [
  { value: 'user', label: '用户', description: '所有项目可用' },
  {
    value: 'project',
    label: '项目',
    description: '写入当前项目 .emperor/settings.json',
  },
  {
    value: 'local',
    label: '本地项目',
    description: '写入当前项目 settings.local.json，不随仓库提交',
  },
]

export const URL_SIGNATURE_NOTICE =
  '从 URL 安装的 Plugin 必须通过签名验证才会激活。目前无法验证签名，安装后会停在「签名未验证」；信任该来源时，请下载后用本地安装。'

export function scopeLabel(scope: string): string {
  if (scope === 'project') return '项目'
  if (scope === 'local') return '本地项目'
  if (scope === 'managed') return '受管'
  return '用户'
}

export function signatureLabel(status: string): string {
  if (status === 'verified') return '签名已验证'
  if (status === 'local_user_source') return '本地来源'
  return '未验证签名'
}

export function sourceLabel(source: PluginPreview['source']): string {
  if (source.kind === 'url') return source.url
  if (source.kind === 'local') return `本地 · ${source.label}`
  return source.marketplace
}

export type PluginTone = 'ok' | 'warn' | 'error' | 'neutral'

/** Runtime state of an installed Plugin (dot / badge copy and tone). */
export function activationState(plugin: PluginSummary): {
  label: string
  tone: PluginTone
} {
  switch (plugin.activation) {
    case 'active':
      return { label: '已激活', tone: 'ok' }
    case 'blocked_unverified':
      return { label: '签名未验证 · 未激活', tone: 'warn' }
    case 'missing':
      return { label: '缺少内容', tone: 'error' }
    default:
      return { label: '已停用', tone: 'neutral' }
  }
}

const CAPABILITY_LABELS = [
  ['skills', 'Skill'],
  ['agents', 'Agent'],
  ['hooks', 'Hook'],
  ['mcpServers', 'MCP'],
  ['lspServers', 'LSP'],
  ['commands', 'Command'],
] as const

type CapabilityCounts = Record<(typeof CAPABILITY_LABELS)[number][0], number>

/** 「Skill · 2」 chips for non-empty capability kinds. */
export function capabilityChips(
  capabilities:
    | CapabilityCounts
    | Record<(typeof CAPABILITY_LABELS)[number][0], readonly string[]>,
): string[] {
  return CAPABILITY_LABELS.flatMap(([key, label]) => {
    const value = capabilities[key]
    const count = typeof value === 'number' ? value : value.length
    return count > 0 ? [`${label} · ${count}`] : []
  })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function shortDigest(digest: string): string {
  return digest ? `${digest.slice(0, 16)}…` : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PluginInstallDeps {
  inspect: (
    source: { kind: 'local'; path: string } | { kind: 'url'; url: string },
  ) => Promise<PluginPreview>
  install: (input: {
    previewId: string
    digest: string
    scope: PluginInstallScope
  }) => Promise<unknown>
  pickFolder: () => Promise<string | null>
  pickZip: () => Promise<string | null>
  /** Called after a confirmed install (reload plugins, skills, MCP…). */
  onInstalled: (preview: PluginPreview) => unknown
}

const defaultDeps = (
  onInstalled: PluginInstallDeps['onInstalled'],
): PluginInstallDeps => ({
  inspect: (source) => core('plugins.inspect', source),
  install: (input) => core('plugins.install', input),
  pickFolder: () => selectDirectory(),
  pickZip: () =>
    selectFile({
      title: '选择 Plugin 压缩包',
      filters: [{ name: 'Plugin zip', extensions: ['zip'] }],
    }),
  onInstalled,
})

/**
 * Reactive install flow behind the 「安装」 header menu and the install
 * dialog: `step` drives the dialog ('url' asks for an address, 'preview'
 * shows what will be installed — or, while `preview` is still null, the
 * inspection progress / failure of a local source), `busy` / `error` its
 * feedback.
 */
export function usePluginInstall(
  deps: Partial<PluginInstallDeps> & Pick<PluginInstallDeps, 'onInstalled'>,
) {
  const api: PluginInstallDeps = { ...defaultDeps(deps.onInstalled), ...deps }
  const state = reactive({
    step: 'closed' as PluginInstallStep,
    url: '',
    preview: null as PluginPreview | null,
    scope: 'user' as PluginInstallScope,
    busy: false,
    error: '',
    /** Last installed Plugin name (section notice). */
    installed: '',
  })
  let token = 0

  const open = computed({
    get: () => state.step !== 'closed',
    set: (value: boolean) => {
      if (!value) close()
    },
  })

  function close(): void {
    token += 1
    state.step = 'closed'
    state.preview = null
    state.busy = false
    state.error = ''
  }

  /** Open the URL step, optionally prefilled (探索 catalog entries). */
  function openUrl(url = ''): void {
    close()
    state.url = url
    state.scope = 'user'
    state.step = 'url'
  }

  async function inspect(
    source: { kind: 'local'; path: string } | { kind: 'url'; url: string },
  ): Promise<void> {
    const run = ++token
    state.busy = true
    state.error = ''
    try {
      const preview = await api.inspect(source)
      if (run !== token) return
      state.preview = preview
      state.step = 'preview'
    } catch (error) {
      if (run !== token) return
      state.error = messageOf(error)
    } finally {
      if (run === token) state.busy = false
    }
  }

  /** Pick a local folder (or zip) and inspect it; a cancelled pick is a no-op. */
  async function installLocal(kind: 'folder' | 'zip'): Promise<void> {
    const path =
      kind === 'folder' ? await api.pickFolder() : await api.pickZip()
    if (!path) return
    close()
    state.scope = 'user'
    state.installed = ''
    // The dialog opens on its preview step at once and shows the inspection
    // progress (a zip is extracted and digested first) or its failure.
    state.step = 'preview'
    await inspect({ kind: 'local', path })
  }

  async function inspectUrl(): Promise<void> {
    const url = state.url.trim()
    if (!url || state.busy) return
    if (!/^https:\/\//i.test(url)) {
      state.error = '只支持 https:// 开头的 Plugin 压缩包地址'
      return
    }
    state.installed = ''
    await inspect({ kind: 'url', url })
  }

  async function confirm(): Promise<void> {
    const preview = state.preview
    if (!preview || state.busy) return
    const run = token
    state.busy = true
    state.error = ''
    try {
      await api.install({
        previewId: preview.previewId,
        digest: preview.digest,
        scope: state.scope,
      })
      if (run !== token) return
      state.installed = preview.name
      close()
      await api.onInstalled(preview)
    } catch (error) {
      if (run !== token) return
      state.error = messageOf(error)
      state.busy = false
    }
  }

  function setUrl(url: string): void {
    state.url = url
    state.error = ''
  }

  function setScope(scope: PluginInstallScope): void {
    state.scope = scope
    state.error = ''
  }

  return {
    state,
    open,
    close,
    openUrl,
    installLocal,
    inspectUrl,
    confirm,
    setUrl,
    setScope,
  }
}

export type PluginInstallFlow = ReturnType<typeof usePluginInstall>
