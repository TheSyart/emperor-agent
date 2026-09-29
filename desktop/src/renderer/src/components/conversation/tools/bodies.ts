// Expanded-body components per registry body kind.
import type { Component } from 'vue'
import AskQuestionView from './AskQuestionView.vue'
import BashView from './BashView.vue'
import ComputerUseView from './ComputerUseView.vue'
import DiffView from './DiffView.vue'
import ExitPlanView from './ExitPlanView.vue'
import GenericToolCard from './GenericToolCard.vue'
import GlobView from './GlobView.vue'
import GrepView from './GrepView.vue'
import JobView from './JobView.vue'
import McpView from './McpView.vue'
import ReadView from './ReadView.vue'
import SchedulerView from './SchedulerView.vue'
import SkillView from './SkillView.vue'
import SubagentView from './SubagentView.vue'
import TodoWriteView from './TodoWriteView.vue'
import WebSearchView from './WebSearchView.vue'
import WorkflowView from './WorkflowView.vue'
import type { ToolBodyKind } from './registry'

export const TOOL_BODIES: Readonly<Record<ToolBodyKind, Component>> = {
  bash: BashView,
  read: ReadView,
  diff: DiffView,
  glob: GlobView,
  grep: GrepView,
  web: WebSearchView,
  todo: TodoWriteView,
  ask: AskQuestionView,
  plan: ExitPlanView,
  subagent: SubagentView,
  job: JobView,
  mcp: McpView,
  scheduler: SchedulerView,
  skill: SkillView,
  workflow: WorkflowView,
  computer: ComputerUseView,
  generic: GenericToolCard,
}
