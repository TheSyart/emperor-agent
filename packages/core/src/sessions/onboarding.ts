/**
 * 首次运行用户偏好档案访谈。单一来源：USER.local.md 的播种/取路径逻辑
 * （原分别重复于 agent/loop.ts 与 api/services/config-service.ts）、
 * "是否仍是种子默认"判定、以及只触发一次的 latch。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowTs } from '../util/time'

const FALLBACK_STUB = '# 用户偏好\n\n'
const LATCH_FILE = 'onboarding.json'

/** 确保 `<stateRoot>/memory/profile/USER.local.md` 存在，缺失时从仓库种子模板拷贝；返回路径。 */
export function ensureUserProfileFile(stateRoot: string, templatesDir: string): string {
  const dir = join(stateRoot, 'memory', 'profile')
  mkdirSync(dir, { recursive: true })
  const userFile = join(dir, 'USER.local.md')
  if (!existsSync(userFile)) {
    const seedPath = join(templatesDir, 'init', 'USER.md')
    const content = existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : FALLBACK_STUB
    writeFileSync(userFile, content, 'utf8')
  }
  return userFile
}

/** 内容是否与种子模板逐字相同（trim 后比较），即"从未被定制过"。 */
export function isUserProfileStillDefault(content: string, seedContent: string): boolean {
  return content.trim() === seedContent.trim()
}

interface OnboardingLatch {
  profileInterviewTriggeredAt: number
}

function latchPath(stateRoot: string): string {
  return join(stateRoot, LATCH_FILE)
}

function readLatch(stateRoot: string): OnboardingLatch | null {
  const path = latchPath(stateRoot)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as OnboardingLatch) : null
  } catch {
    return null
  }
}

function writeLatch(stateRoot: string): void {
  writeFileSync(latchPath(stateRoot), JSON.stringify({ profileInterviewTriggeredAt: nowTs() } satisfies OnboardingLatch, null, 2), 'utf8')
}

/**
 * 原子地"检查+必要时立刻置位"，返回这次启动是否应该真正发起访谈 turn。
 * - 已置位过 → false（永不重复）。
 * - 档案已被定制过（老用户升级场景）→ 立刻置位但 false（不打扰）。
 * - 仍是默认但模型未配置 → 不置位、false（留到下次启动再判断，不浪费只发一次的机会）。
 * - 仍是默认且模型已配置 → 置位、true。
 */
export function claimProfileOnboardingTrigger(opts: {
  stateRoot: string
  templatesDir: string
  hasConfiguredModel: boolean
}): boolean {
  if (readLatch(opts.stateRoot) !== null) return false

  const userFile = ensureUserProfileFile(opts.stateRoot, opts.templatesDir)
  const seedPath = join(opts.templatesDir, 'init', 'USER.md')
  const seedContent = existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : FALLBACK_STUB
  const currentContent = readFileSync(userFile, 'utf8')

  if (!isUserProfileStillDefault(currentContent, seedContent)) {
    writeLatch(opts.stateRoot)
    return false
  }
  if (!opts.hasConfiguredModel) return false

  writeLatch(opts.stateRoot)
  return true
}

/** 仿 SchedulerJobExecutor.agentTurnContent()：合成一次"user turn"内容，驱动模型自主访谈。 */
export function onboardingTriggerContent(): string {
  return [
    '[ONBOARDING_TRIGGER]',
    '',
    '这是首次运行，用户偏好档案为空。请调用一次 ask_user（把下面这些问题合并到同一次交互里问完，不要分多轮）：',
    '',
    '- 称呼、时区、语言',
    '- 沟通风格（随意自然 / 正式专业 / 技术导向 / 指令简洁化）',
    '- 回复长度偏好（简洁明了 / 详细解释 / 根据问题自适应）',
    '- 技术水平（初学者 / 中级 / 专家）',
    '- 工作背景（主要角色、主要事务、常用工具）',
    '- 兴趣领域',
    '- 性格与工作风格',
    '- 角色互动偏好',
    '',
    '拿到回答后，调用 save_user_profile 把结果整理写回完整档案。完成后只需简短确认，不必长篇大论。',
  ].join('\n')
}
