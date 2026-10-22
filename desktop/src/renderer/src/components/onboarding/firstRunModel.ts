/**
 * The first-run guide's copy (UI-S17): the two ways in on 欢迎, the step
 * rail and each step's heading. Pure data; the guide is
 * FirstRunOnboarding.vue, which drives the add-model dialog's own
 * controller and steps. When it opens: firstRunGate.ts.
 */
import type { ProviderOption } from '../../types'
import type {
  AddModelStep,
  LocalStatus,
} from '../settings/model/addModelController'

export type FirstRunStage = 'welcome' | 'setup' | 'ready'

export interface WelcomeChoice {
  key: 'local' | 'key'
  title: string
  description: string
  /** A local server answered: this way needs nothing else. */
  recommended: boolean
  /** The provider to connect (local: the running one, else the first). */
  provider: string | null
}

const KEY_PROVIDERS = 'DeepSeek、Kimi、通义千问、OpenAI、Anthropic 等'

/**
 * 欢迎's two ways in. A running local server goes first and is
 * recommended; otherwise the API key comes first. Until every local
 * server has answered (`probed`), the order stays key-first.
 */
export function welcomeChoices(
  options: readonly ProviderOption[],
  local: Readonly<Record<string, LocalStatus>>,
  probed: boolean,
): WelcomeChoice[] {
  const locals = options.filter((option) => option.isLocal)
  const running = locals.find((option) => local[option.name]?.running)
  const count = running ? local[running.name]?.count : null
  const name = (option: ProviderOption) => option.displayName ?? option.name
  const localChoice: WelcomeChoice = {
    key: 'local',
    title: '使用本机模型',
    description: running
      ? `${name(running)} 运行中${count ? ` · ${count} 个模型` : ''}，不需要 Key`
      : probed
        ? '支持 Ollama、LM Studio · 暂未检测到运行中的服务'
        : '正在检测本机服务…',
    recommended: Boolean(running),
    provider: running?.name ?? locals[0]?.name ?? null,
  }
  const keyChoice: WelcomeChoice = {
    key: 'key',
    title: '使用 API Key',
    description: KEY_PROVIDERS,
    recommended: false,
    provider: null,
  }
  return running ? [localChoice, keyChoice] : [keyChoice, localChoice]
}

export const RAIL = ['连接', '选择模型', '完成'] as const

/** The rail's current item: 确认参数 belongs to 选择模型. */
export function railIndex(stage: FirstRunStage, step: AddModelStep): number {
  if (stage === 'ready') return 2
  if (stage === 'welcome') return -1
  return step === 'connect' ? 0 : 1
}

export interface SetupHeading {
  title: string
  subtitle: string
}

export function setupHeading(input: {
  step: AddModelStep
  provider: string | null
  providerLabel: string
  isLocal: boolean
  running: boolean
  modelCount: number
}): SetupHeading {
  const label = input.providerLabel
  if (input.step === 'pick')
    return {
      title: '选择要用的模型',
      subtitle: `已连接 ${label}，找到 ${input.modelCount} 个模型，推荐的已经选好。`,
    }
  if (input.step === 'confirm')
    return {
      title: '核对模型参数',
      subtitle: '有的数值没有可靠来源，请核对后再保存。',
    }
  if (!input.provider)
    return {
      title: '选择模型服务',
      subtitle: '国内外主流供应商都支持，也可以粘贴任意 OpenAI 兼容地址。',
    }
  if (input.isLocal)
    return {
      title: `连接本机的 ${label}`,
      subtitle: input.running
        ? '已检测到本机服务，不需要 Key。'
        : `还没有检测到运行中的 ${label}，启动后再连接。`,
    }
  return {
    title: `连接 ${label}`,
    subtitle: `粘贴 ${label} 的 API Key，Emperor 会自动获取可用的模型。`,
  }
}
