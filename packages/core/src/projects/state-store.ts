import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PROJECT_MEMORY_START = '<!-- emperor-agent:project-memory:start -->'
export const PROJECT_MEMORY_END = '<!-- emperor-agent:project-memory:end -->'
export const DEFAULT_PROJECT_MEMORY_BLOCK = '## Emperor Agent Project Memory\n\n- 尚未记录项目情况。'

export interface ProjectStateInput {
  project_id: string
  project_path: string
  workspace_path?: string
  project_name: string
  summary: string
  created_at: string
  updated_at: string
  version: number
}

export interface ProjectStatePaths {
  state_path: string
  memory_path: string
  agents_path: string
  project_json_path: string
  prompt_overlay_path: string
}

export interface ProjectStateMetadata extends ProjectStateInput, ProjectStatePaths {
  workspace_path: string
  legacy_agents_path: string | null
  legacy_imported_at: string | null
}

export class ProjectStateStore {
  readonly projectsDir: string

  constructor(projectsDir: string) {
    this.projectsDir = resolve(projectsDir)
  }

  paths(projectId: string): ProjectStatePaths {
    const statePath = join(this.projectsDir, projectId)
    const memoryPath = join(statePath, 'AGENTS.local.md')
    return {
      state_path: statePath,
      memory_path: memoryPath,
      agents_path: memoryPath,
      project_json_path: join(statePath, 'project.json'),
      prompt_overlay_path: join(statePath, 'prompt-overlay.md'),
    }
  }

  ensureProject(input: ProjectStateInput): ProjectStateMetadata {
    const paths = this.paths(input.project_id)
    mkdirSync(paths.state_path, { recursive: true })
    const existingMeta = readProjectJson(paths.project_json_path)
    let legacyAgentsPath = nullableString(existingMeta.legacy_agents_path)
    let legacyImportedAt = nullableString(existingMeta.legacy_imported_at)

    if (!existsSync(paths.memory_path)) {
      const legacy = this.readLegacyProjectMemory(input.project_path)
      if (legacy.content) {
        legacyAgentsPath = legacy.path
        legacyImportedAt = stamp()
      }
      writeFileSync(
        paths.memory_path,
        '# Project Memory\n\n' +
          `${PROJECT_MEMORY_START}\n${legacy.content || DEFAULT_PROJECT_MEMORY_BLOCK}\n${PROJECT_MEMORY_END}\n`,
        'utf8',
      )
    }
    if (!existsSync(paths.prompt_overlay_path)) writeFileSync(paths.prompt_overlay_path, '', 'utf8')

    const metadata: ProjectStateMetadata = {
      ...input,
      workspace_path: input.workspace_path || input.project_path,
      ...paths,
      legacy_agents_path: legacyAgentsPath,
      legacy_imported_at: legacyImportedAt,
    }
    this.writeProjectJson(metadata)
    return metadata
  }

  readAgents(projectId: string): string {
    const path = this.paths(projectId).memory_path
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  readManagedMemory(projectId: string): string {
    return extractProjectMemoryBlock(this.readAgents(projectId)) ?? ''
  }

  writeManagedMemory(projectId: string, content: string): void {
    const paths = this.paths(projectId)
    mkdirSync(paths.state_path, { recursive: true })
    const current = existsSync(paths.memory_path)
      ? readFileSync(paths.memory_path, 'utf8')
      : `# Project Memory\n\n${PROJECT_MEMORY_START}\n${DEFAULT_PROJECT_MEMORY_BLOCK}\n${PROJECT_MEMORY_END}\n`
    const text = replaceProjectMemoryBlock(current, content.trim() || DEFAULT_PROJECT_MEMORY_BLOCK)
    atomicWriteText(paths.memory_path, text.trimEnd() + '\n')
  }

  readPromptOverlay(projectId: string): string {
    const path = this.paths(projectId).prompt_overlay_path
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  readWorkspaceCollaborationContext(projectId: string): string {
    const metadata = readProjectJson(this.paths(projectId).project_json_path)
    const workspacePath = nullableString(metadata.workspace_path) ?? nullableString(metadata.project_path)
    if (!workspacePath) return ''

    const sections: string[] = []
    pushTextSection(sections, 'Workspace AGENTS.md', join(workspacePath, 'AGENTS.md'))
    pushJsonSection(sections, 'Workspace .emperor/settings.json', join(workspacePath, '.emperor', 'settings.json'))
    pushJsonSection(sections, 'Workspace .emperor/settings.local.json', join(workspacePath, '.emperor', 'settings.local.json'))
    for (const rule of listMarkdownFiles(join(workspacePath, '.emperor', 'rules'))) {
      pushTextSection(sections, `Workspace .emperor/rules/${rule}`, join(workspacePath, '.emperor', 'rules', rule))
    }
    return sections.join('\n\n').trim()
  }

  writePromptOverlay(projectId: string, content: string): void {
    const paths = this.paths(projectId)
    mkdirSync(paths.state_path, { recursive: true })
    atomicWriteText(paths.prompt_overlay_path, `${String(content || '').trimEnd()}\n`)
  }

  writeProjectJson(metadata: ProjectStateMetadata): void {
    const paths = this.paths(metadata.project_id)
    mkdirSync(paths.state_path, { recursive: true })
    atomicWriteText(paths.project_json_path, JSON.stringify(metadata, null, 2) + '\n')
  }

  private readLegacyProjectMemory(projectPath: string): { path: string | null; content: string } {
    const agentsPath = join(projectPath, 'AGENTS.md')
    if (!existsSync(agentsPath)) return { path: null, content: '' }
    return { path: agentsPath, content: extractProjectMemoryBlock(readFileSync(agentsPath, 'utf8')) ?? '' }
  }
}

export function extractProjectMemoryBlock(text: string): string | null {
  const start = text.indexOf(PROJECT_MEMORY_START)
  const end = text.indexOf(PROJECT_MEMORY_END)
  if (start < 0 || end < 0 || end < start) return null
  return text.slice(start + PROJECT_MEMORY_START.length, end).trim()
}

export function replaceProjectMemoryBlock(text: string, content: string): string {
  const start = text.indexOf(PROJECT_MEMORY_START)
  const end = text.indexOf(PROJECT_MEMORY_END)
  if (start < 0 || end < 0 || end < start) {
    return `${text.trimEnd()}\n\n${PROJECT_MEMORY_START}\n${content.trim()}\n${PROJECT_MEMORY_END}`
  }
  const bodyStart = start + PROJECT_MEMORY_START.length
  return `${text.slice(0, bodyStart).trimEnd()}\n${content.trim()}\n${text.slice(end).trimStart()}`
}

function readProjectJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8') || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function atomicWriteText(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

function stamp(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0800`
}

function pushTextSection(sections: string[], title: string, path: string): void {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8').trim()
  if (!content) return
  sections.push(`# ${title}\n\n${content}`)
}

function pushJsonSection(sections: string[], title: string, path: string): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return
  try {
    sections.push(`# ${title}\n\n\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``)
  } catch {
    sections.push(`# ${title}\n\n\`\`\`json\n${raw}\n\`\`\``)
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md') && !name.includes('/') && !name.includes('\\'))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}
