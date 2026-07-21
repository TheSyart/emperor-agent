/**
 * ClarificationPolicy (MIG-CTRL-003)。对齐 Python `agent/control/clarification.py`。
 * 高影响歧义统一判断是否先 ask_user。_CONTROL_RESUME_RE 导出供 plan-drafting 复用。
 */

export const CONTROL_RESUME_RE =
  /^\[CONTROL:(ASK_ANSWERED|PERMISSION_ANSWERED|PLAN_APPROVED|PLAN_COMMENT|INTERACTION_CANCELLED)\]/
const IMPLEMENT_PLAN_RE =
  /please\s+implement\s+this\s+plan|#\s*(summary|key changes|test plan)/i
const EXPLICIT_AUTONOMY_RE =
  /(不用问|不要问|直接做|按你判断|自行决定|你决定|无需确认)/
const BROAD_SCOPE_RE =
  /(工程化|架构|重构|重新设计|设计.*机制|解决以上问题|找到问题作出修改|通读项目|仔细阅读|审计.*修改|从头到尾|全链路|全项目|整体.*(优化|完善|改造|提升)|(项目|系统|机制|工作流|提示词|agent|Agent).*(优化|完善|改造|评估|审计)|(优化|完善|改造|评估|审计).*(项目|系统|机制|工作流|提示词|agent|Agent))/
const LOW_RISK_RE =
  /(改错别字|修拼写|解释|说明|查看|查询|列出|读一下|review|审查)/

export interface ClarificationAssessment {
  required: boolean
  reason: string
  categories: string[]
  questions: Array<Record<string, unknown>>
}

export function emptyClarification(): ClarificationAssessment {
  return { required: false, reason: '', categories: [], questions: [] }
}

export function clarificationPrompt(a: ClarificationAssessment): string {
  if (!a.required) return ''
  return [
    '# Ask Guard',
    '当前用户任务存在会影响实现路径的高影响歧义。你可以先使用只读工具理解项目，但在进行写入、派遣子代理、Agent Team 写操作或给出最终答复前，必须调用 `ask_user`。',
    `触发原因：${a.reason}`,
    '推荐问题已经由策略层给出；如你要提问，请直接围绕这些问题调用 `ask_user`，不要用普通文字询问。',
  ].join('\n')
}

export class ClarificationPolicy {
  assess(history: Array<Record<string, unknown>>): ClarificationAssessment {
    const latest = latestUserText(history)
    if (!latest) return emptyClarification()
    const lowered = latest.toLowerCase()
    if (CONTROL_RESUME_RE.test(latest) || IMPLEMENT_PLAN_RE.test(latest))
      return emptyClarification()

    const categories: string[] = []
    if (BROAD_SCOPE_RE.test(latest)) categories.push('scope')
    if (
      lowered.includes('ui') ||
      latest.includes('界面') ||
      latest.includes('前端') ||
      latest.includes('视觉')
    )
      categories.push('ui')

    if (!categories.length) return emptyClarification()
    if (LOW_RISK_RE.test(latest)) return emptyClarification()
    if (EXPLICIT_AUTONOMY_RE.test(latest)) return emptyClarification()
    if (looksDecisionComplete(latest)) return emptyClarification()

    const questions = questionsFor(categories)
    const reason = [...new Set(categories)].join('、')
    return { required: true, reason, categories, questions }
  }
}

function latestUserText(history: Array<Record<string, unknown>>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).type === 'text'
        ) {
          parts.push(String((item as Record<string, unknown>).text ?? ''))
        }
      }
      return parts.join('\n').trim()
    }
    return String(content ?? '').trim()
  }
  return ''
}

function looksDecisionComplete(text: string): boolean {
  const headings = (text.match(/^#{1,3}\s+/gm) || []).length
  const bullets = (text.match(/^\s*[-*]\s+/gm) || []).length
  const hasTests = /(测试|验收|test plan|tests?)/i.test(text)
  const hasInterfaces = /(api|接口|types?|schema|public interfaces?)/i.test(
    text,
  )
  return (
    text.length > 500 &&
    (headings >= 2 || bullets >= 5) &&
    (hasTests || hasInterfaces)
  )
}

function questionsFor(categories: string[]): Array<Record<string, unknown>> {
  const questions: Array<Record<string, unknown>> = []
  if (categories.includes('scope')) {
    questions.push({
      id: 'scope',
      header: '范围',
      question: '这次任务的实施边界优先按哪种方式推进？',
      options: [
        {
          label: '完整工程化',
          description: '按长期可维护方案处理模块、测试与文档。',
        },
        { label: '最小修复', description: '只修当前可见问题，尽量少动结构。' },
        { label: '先出方案', description: '先产出更详细计划，确认后再实施。' },
      ],
    })
  }
  if (categories.includes('ui')) {
    questions.push({
      id: 'ui_priority',
      header: '前端',
      question: '涉及界面时，视觉与交互优先级如何取舍？',
      options: [
        {
          label: '产品级体验',
          description: '按正式功能页标准打磨布局、状态和响应式。',
        },
        {
          label: '保持现状',
          description: '只接入必要状态，不做明显视觉调整。',
        },
      ],
    })
  }
  return questions.slice(0, 3)
}
