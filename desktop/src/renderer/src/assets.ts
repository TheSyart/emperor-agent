const brandFavicon = new URL('../../../../assets/brand/favicon.ico', import.meta.url).href
const brandLogoMark = new URL('../../../../assets/brand/logo-mark.png', import.meta.url).href
const brandLogoSeal = new URL('../../../../assets/brand/logo-seal.png', import.meta.url).href
const brandOgCover = new URL('../../../../assets/brand/og-cover.png', import.meta.url).href

const actionClear = new URL('../../../../assets/actions/action-clear.png', import.meta.url).href
const actionCopy = new URL('../../../../assets/actions/action-copy.png', import.meta.url).href
const actionNew = new URL('../../../../assets/actions/action-new.png', import.meta.url).href
const actionRefresh = new URL('../../../../assets/actions/action-refresh.png', import.meta.url).href
const actionSave = new URL('../../../../assets/actions/action-save.png', import.meta.url).href
const actionAttach = new URL('../../../../assets/actions/action-attach.png', import.meta.url).href
const actionSend = new URL('../../../../assets/actions/action-send.png', import.meta.url).href
const caretDown = new URL('../../../../assets/actions/caret-down.png', import.meta.url).href
const modeAskBeforeEdit = new URL('../../../../assets/actions/mode-ask-before-edit.png', import.meta.url).href
const modeAuto = new URL('../../../../assets/actions/mode-auto.png', import.meta.url).href
const modePlan = new URL('../../../../assets/actions/mode-plan.png', import.meta.url).href
const statusBusy = new URL('../../../../assets/actions/status-busy.png', import.meta.url).href
const statusError = new URL('../../../../assets/actions/status-error.png', import.meta.url).href
const statusOnline = new URL('../../../../assets/actions/status-online.png', import.meta.url).href

const avatarEmperor = new URL('../../../../assets/avatars/avatar-emperor.png', import.meta.url).href
const avatarEunuch = new URL('../../../../assets/avatars/avatar-eunuch.png', import.meta.url).href
const avatarSubagent = new URL('../../../../assets/avatars/avatar-subagent.png', import.meta.url).href

const attachmentFile = new URL('../../../../assets/attachments/attachment-file.png', import.meta.url).href
const attachmentImage = new URL('../../../../assets/attachments/attachment-image.png', import.meta.url).href
const attachmentMarkdown = new URL('../../../../assets/attachments/attachment-markdown.png', import.meta.url).href
const attachmentPdf = new URL('../../../../assets/attachments/attachment-pdf.png', import.meta.url).href
const attachmentText = new URL('../../../../assets/attachments/attachment-text.png', import.meta.url).href

const emptyMemory = new URL('../../../../assets/empty/empty-memory.png', import.meta.url).href
const emptySkills = new URL('../../../../assets/empty/empty-skills.png', import.meta.url).href
const emptyTools = new URL('../../../../assets/empty/empty-tools.png', import.meta.url).href
const emptyWelcome = new URL('../../../../assets/empty/welcome-hero.png', import.meta.url).href

const modelText = new URL('../../../../assets/model/model-text.png', import.meta.url).href
const modelTestFail = new URL('../../../../assets/model/model-test-fail.png', import.meta.url).href
const modelTestOk = new URL('../../../../assets/model/model-test-ok.png', import.meta.url).href
const modelVision = new URL('../../../../assets/model/model-vision.png', import.meta.url).href

const navChat = new URL('../../../../assets/nav/nav-chat.png', import.meta.url).href
const navChatActive = new URL('../../../../assets/nav/nav-chat-active.png', import.meta.url).href
const navModel = new URL('../../../../assets/nav/nav-model.png', import.meta.url).href
const navModelActive = new URL('../../../../assets/nav/nav-model-active.png', import.meta.url).href
const navTokens = new URL('../../../../assets/nav/nav-tokens.png', import.meta.url).href
const navTokensActive = new URL('../../../../assets/nav/nav-tokens-active.png', import.meta.url).href
const navSkills = new URL('../../../../assets/nav/nav-skills.png', import.meta.url).href
const navSkillsActive = new URL('../../../../assets/nav/nav-skills-active.png', import.meta.url).href
const navTools = new URL('../../../../assets/nav/nav-tools.png', import.meta.url).href
const navToolsActive = new URL('../../../../assets/nav/nav-tools-active.png', import.meta.url).href
const navTeam = new URL('../../../../assets/nav/nav-team.png', import.meta.url).href
const navTeamActive = new URL('../../../../assets/nav/nav-team-active.png', import.meta.url).href
const navScheduler = new URL('../../../../assets/nav/nav-scheduler.png', import.meta.url).href
const navSchedulerActive = new URL('../../../../assets/nav/nav-scheduler-active.png', import.meta.url).href
const navConfigs = new URL('../../../../assets/nav/nav-configs.png', import.meta.url).href
const navConfigsActive = new URL('../../../../assets/nav/nav-configs-active.png', import.meta.url).href
const navMcp = new URL('../../../../assets/nav/nav-mcp.png', import.meta.url).href
const navMcpActive = new URL('../../../../assets/nav/nav-mcp-active.png', import.meta.url).href
const navMemory = new URL('../../../../assets/nav/nav-memory.png', import.meta.url).href
const navMemoryActive = new URL('../../../../assets/nav/nav-memory-active.png', import.meta.url).href

const toolDefault = new URL('../../../../assets/tools/tool-default.png', import.meta.url).href
const toolEdit = new URL('../../../../assets/tools/tool-edit.png', import.meta.url).href
const toolGlob = new URL('../../../../assets/tools/tool-glob.png', import.meta.url).href
const toolGrep = new URL('../../../../assets/tools/tool-grep.png', import.meta.url).href
const toolRead = new URL('../../../../assets/tools/tool-read.png', import.meta.url).href
const toolShell = new URL('../../../../assets/tools/tool-shell.png', import.meta.url).href
const toolSkill = new URL('../../../../assets/tools/tool-skill.png', import.meta.url).href
const toolSubagent = new URL('../../../../assets/tools/tool-subagent.png', import.meta.url).href
const toolTodo = new URL('../../../../assets/tools/tool-todo.png', import.meta.url).href
const toolWeb = new URL('../../../../assets/tools/tool-web.png', import.meta.url).href
const toolWrite = new URL('../../../../assets/tools/tool-write.png', import.meta.url).href

export const brandAssets = {
  favicon: brandFavicon,
  logoMark: brandLogoMark,
  logoSeal: brandLogoSeal,
  ogCover: brandOgCover,
}

export const actionAssets = {
  attach: actionAttach,
  clear: actionClear,
  copy: actionCopy,
  new: actionNew,
  refresh: actionRefresh,
  save: actionSave,
  send: actionSend,
  caretDown,
  modeAskBeforeEdit,
  modeAuto,
  modePlan,
  statusBusy,
  statusError,
  statusOnline,
}

export const avatarAssets = {
  emperor: avatarEmperor,
  eunuch: avatarEunuch,
  subagent: avatarSubagent,
}

export const attachmentAssets = {
  file: attachmentFile,
  image: attachmentImage,
  markdown: attachmentMarkdown,
  pdf: attachmentPdf,
  text: attachmentText,
}

export const emptyAssets = {
  memory: emptyMemory,
  skills: emptySkills,
  tools: emptyTools,
  welcome: emptyWelcome,
}

export const modelAssets = {
  text: modelText,
  testFail: modelTestFail,
  testOk: modelTestOk,
  vision: modelVision,
}

export const navAssets = {
  chat: navChat,
  chatActive: navChatActive,
  model: navModel,
  modelActive: navModelActive,
  tokens: navTokens,
  tokensActive: navTokensActive,
  skills: navSkills,
  skillsActive: navSkillsActive,
  tools: navTools,
  toolsActive: navToolsActive,
  team: navTeam,
  teamActive: navTeamActive,
  scheduler: navScheduler,
  schedulerActive: navSchedulerActive,
  configs: navConfigs,
  configsActive: navConfigsActive,
  mcp: navMcp,
  mcpActive: navMcpActive,
  memory: navMemory,
  memoryActive: navMemoryActive,
}

export const toolAssets = {
  default: toolDefault,
  edit: toolEdit,
  glob: toolGlob,
  grep: toolGrep,
  read: toolRead,
  shell: toolShell,
  skill: toolSkill,
  subagent: toolSubagent,
  todo: toolTodo,
  web: toolWeb,
  write: toolWrite,
}

export function navIcon(name: string, active: boolean) {
  const key = `${name}${active ? 'Active' : ''}` as keyof typeof navAssets
  return navAssets[key] || navAssets.chat
}

export function toolIcon(name: string) {
  const lower = name.toLowerCase()
  if (lower.includes('dispatch') || lower.includes('subagent')) return toolAssets.subagent
  if (lower.includes('team') || lower.includes('teammate') || lower.includes('broadcast')) return toolAssets.subagent
  if (lower.includes('todo')) return toolAssets.todo
  if (lower.includes('grep')) return toolAssets.grep
  if (lower.includes('glob')) return toolAssets.glob
  if (lower.includes('read')) return toolAssets.read
  if (lower.includes('write')) return toolAssets.write
  if (lower.includes('edit')) return toolAssets.edit
  if (lower.includes('skill')) return toolAssets.skill
  if (lower.includes('web') || lower.includes('fetch')) return toolAssets.web
  if (lower.includes('run') || lower.includes('command') || lower.includes('shell')) return toolAssets.shell
  return toolAssets.default
}

export function attachmentIcon(kind: string, mime?: string, name?: string) {
  const lowerMime = (mime || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()
  if (kind === 'image' || lowerMime.startsWith('image/')) return attachmentAssets.image
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) return attachmentAssets.pdf
  if (
    lowerMime.includes('markdown') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown') ||
    lowerName.endsWith('.mdx')
  ) return attachmentAssets.markdown
  if (
    kind === 'text' ||
    lowerMime.startsWith('text/') ||
    lowerMime.includes('json') ||
    lowerName.endsWith('.json') ||
    lowerName.endsWith('.csv') ||
    lowerName.endsWith('.txt')
  ) return attachmentAssets.text
  return attachmentAssets.file
}
