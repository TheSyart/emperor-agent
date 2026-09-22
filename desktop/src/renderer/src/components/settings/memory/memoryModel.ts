/**
 * Settings › 记忆 — pure projection helpers (no Vue): the 「上下文概览」 fact
 * groups (context, history log, semantic compaction, runtime, maintenance),
 * editor paths, episode / version labels and the watchlist decision facts.
 */
import type {
  MemoryPayload,
  MemoryVersion,
  ProfileOnboardingStatus,
  WatchlistDecision,
} from '../../../types'
import type { DefinitionItem } from '../ui'

export type MemoryTab =
  'long_term' | 'profile' | 'episodes' | 'watchlist' | 'versions'

export const MEMORY_TABS: Array<{ value: MemoryTab; label: string }> = [
  { value: 'long_term', label: '长期' },
  { value: 'profile', label: '用户档案' },
  { value: 'episodes', label: '情景' },
  { value: 'watchlist', label: 'Watchlist' },
  { value: 'versions', label: '版本' },
]

export const USER_PROFILE_PATH = 'memory/profile/USER.local.md'
export const WATCHLIST_PATH = 'memory/watchlist.md'

export function formatBytes(value?: number): string {
  const bytes = Math.max(0, Number(value || 0))
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}

export function formatNumber(value?: number): string {
  return Math.max(0, Number(value || 0)).toLocaleString('zh-CN')
}

/** `memory/episodes/2026-06-26.md` → `2026-06-26`. */
export function episodeDate(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') || ''
}

/** Newest episode first. */
export function sortedEpisodes(memory: MemoryPayload | null): string[] {
  return [...(memory?.episodes || [])].sort((a, b) => b.localeCompare(a))
}

export function isBuildContext(memory: MemoryPayload | null): boolean {
  return memory?.context?.mode === 'build'
}

/** The long-term editor source: project memory (Build) or MEMORY.local.md. */
export function longTermContent(memory: MemoryPayload | null): string {
  return isBuildContext(memory)
    ? memory?.context?.projectMemory || ''
    : memory?.long_term || ''
}

export function longTermPath(memory: MemoryPayload | null): string {
  return isBuildContext(memory)
    ? '全局私有项目记忆 · AGENTS.local.md 托管区块'
    : '全局长期记忆 · MEMORY.local.md'
}

export function longTermNote(memory: MemoryPayload | null): string {
  return isBuildContext(memory)
    ? 'Build 压缩会更新全局 store 中的项目记忆，不改写项目 AGENTS.md；此处只读。'
    : '保存后刷新 Agent 上下文。'
}

const VERSION_TARGETS: Record<string, string> = {
  memory: '长期记忆',
  user: '用户档案',
  episode: '情景记忆',
  project: '项目记忆',
}

export function versionTargetLabel(target: string): string {
  return VERSION_TARGETS[target] || target || '记忆'
}

/** Version snapshots carry epoch seconds. */
export function formatVersionTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString('zh-CN', { hour12: false })
}

export function versionDescription(version: MemoryVersion): string {
  return [
    versionTargetLabel(version.target),
    version.reason,
    formatVersionTime(version.createdAt),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function onboardingLabel(status?: ProfileOnboardingStatus): string {
  if (status === 'completed') return '已完成'
  if (status === 'in_progress') return '访谈进行中'
  if (status === 'skipped') return '已跳过'
  return '待补充'
}

export function onboardingTone(
  status?: ProfileOnboardingStatus,
): 'ok' | 'accent' | 'neutral' | 'warn' {
  if (status === 'completed') return 'ok'
  if (status === 'in_progress') return 'accent'
  if (status === 'skipped') return 'neutral'
  return 'warn'
}

export function watchlistFacts(
  decision: WatchlistDecision | null | undefined,
): DefinitionItem[] {
  if (!decision) return []
  const items: DefinitionItem[] = [
    { term: '最近决策', value: decision.action || 'skip' },
    { term: '原因', value: decision.reason || '暂无原因' },
    {
      term: '决策模型',
      value:
        [decision.modelRole, decision.provider, decision.model]
          .filter(Boolean)
          .join(' · ') || '未记录',
    },
  ]
  if (decision.checkedAt)
    items.push({
      term: '检查时间',
      value: new Date(decision.checkedAt).toLocaleString('zh-CN', {
        hour12: false,
      }),
    })
  return items
}

export interface ContextGroup {
  key: string
  title: string
  /** A value in this group needs attention (rotation / blocked archive). */
  warn: boolean
  items: DefinitionItem[]
}

/** The facts behind 「上下文概览」, one group per available stats block. */
export function contextGroups(memory: MemoryPayload | null): ContextGroup[] {
  if (!memory) return []
  const groups: ContextGroup[] = []
  const context = memory.context
  if (context) {
    const build = context.mode === 'build'
    const items: DefinitionItem[] = [
      { term: '模式', value: build ? 'Build · 项目记忆' : 'Chat · 全局记忆' },
    ]
    if (build) {
      items.push(
        {
          term: '项目',
          value:
            context.project?.project_name ||
            context.session?.project_name ||
            '未绑定项目',
        },
        {
          term: '源码',
          value:
            context.project?.workspace_path ||
            context.project?.project_path ||
            context.session?.project_path ||
            '项目路径不可用',
          mono: true,
        },
        {
          term: 'Agent 状态',
          value: `${context.project?.state_path ? '已隔离' : '未知'} · ${
            context.project?.memory_path ||
            context.project?.agents_path ||
            '项目记忆路径不可用'
          }`,
        },
      )
    } else {
      items.push({
        term: '项目索引',
        value: `${context.projectIndexSummary ? '已注入短摘要' : '暂无项目摘要'} · Chat 不读取项目 AGENTS.md 细节`,
      })
    }
    const sources = context.sources || []
    items.push({
      term: '来源',
      value: sources.length
        ? `${sources.length} 个 · ${sources.join(' · ')}`
        : '0 个',
    })
    groups.push({ key: 'context', title: '当前上下文', warn: false, items })
  }

  const history = memory.history
  if (history) {
    groups.push({
      key: 'history',
      title: '历史日志',
      warn: Boolean(history.needs_rotation),
      items: [
        {
          term: '热日志',
          value: `${formatBytes(history.active_bytes)} · ${formatNumber(history.active_lines)} 行 · seq ${formatNumber(history.latest_seq)}`,
        },
        {
          term: '冷归档',
          value: `${formatBytes(history.archive_bytes)} · ${formatNumber(history.archive_files)} 个 gzip 文件`,
        },
        {
          term: '最近归档',
          value: `${history.last_archive_at ? history.last_archive_at.slice(0, 10) : '暂无'} · ${
            history.needs_rotation ? '热日志接近上限' : '容量正常'
          }`,
        },
      ],
    })
  }

  const compaction = memory.compaction
  if (compaction) {
    const cursor = compaction.cursor
    const archive = compaction.archive
    const latest = compaction.latest
    groups.push({
      key: 'compaction',
      title: '语义压缩',
      warn: Boolean(archive?.archiveBlockedUntilCompacted),
      items: [
        {
          term: '压缩游标',
          value: `${
            cursor?.compactedUntilSeq
              ? `seq ${formatNumber(cursor.compactedUntilSeq)}`
              : '未压缩'
          } · ${cursor?.status || 'active'} · ${cursor?.lastCompactionId || '暂无 compaction id'}`,
        },
        {
          term: '归档边界',
          value: `archive seq ${formatNumber(archive?.archivedUntilSeq)} · 只允许归档到 compacted seq ${formatNumber(archive?.compactedUntilSeq)}`,
        },
        {
          term: '最近压缩',
          value: `${latest?.status ? String(latest.status) : '暂无'} · ${
            latest?.compactionId
              ? String(latest.compactionId)
              : 'Runtime 事件归档与语义压缩分离'
          }`,
        },
      ],
    })
  }

  const runtime = memory.runtime
  if (runtime) {
    groups.push({
      key: 'runtime',
      title: 'Runtime',
      warn: false,
      items: [
        {
          term: '热记录',
          value: `${formatBytes(runtime.bytes)} · ${formatNumber(runtime.events)} 个事件 · seq ${formatNumber(runtime.latestSeq)}`,
        },
        {
          term: '活跃 Turn',
          value: `${formatNumber(runtime.activeTurns)} · ${formatNumber(runtime.activeTurnEvents)} 个可重放事件`,
        },
        {
          term: '冷归档',
          value: `${formatBytes(runtime.archiveBytes)} · ${formatNumber(runtime.archiveFiles)} 个 gzip 文件`,
        },
      ],
    })
  }

  const maintenance = memory.schedulerMaintenance
  if (maintenance) {
    const next = maintenance.nextRunAtMs
      ? new Date(maintenance.nextRunAtMs)
      : null
    groups.push({
      key: 'maintenance',
      title: '系统维护',
      warn: Boolean(maintenance.lastError),
      items: [
        {
          term: '维护任务',
          value: `${formatNumber(maintenance.enabled)} / ${formatNumber(maintenance.jobs)} · ${
            maintenance.lastError || '受保护 Scheduler jobs'
          }`,
        },
        {
          term: '下次维护',
          value: next
            ? `${next.toLocaleDateString('zh-CN')} ${next.toLocaleTimeString('zh-CN', { hour12: false })}`
            : '暂无 · Scheduler 未安排',
        },
      ],
    })
  }
  return groups
}

/** One line under 「上下文概览」 (mode · hot log · sources). */
export function contextSummary(memory: MemoryPayload | null): string {
  if (!memory) return '暂无记忆数据'
  const parts: string[] = []
  const context = memory.context
  if (context)
    parts.push(
      context.mode === 'build' ? 'Build · 项目记忆' : 'Chat · 全局记忆',
    )
  if (memory.history)
    parts.push(`热日志 ${formatBytes(memory.history.active_bytes)}`)
  if (context) parts.push(`${(context.sources || []).length} 个来源`)
  if (memory.versions)
    parts.push(`${memory.versions.versions?.length || 0} 个版本`)
  return parts.join(' · ') || '暂无统计'
}
