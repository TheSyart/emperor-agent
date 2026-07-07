import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LLMProvider, type ChatArgs, type LLMResponse } from '../providers/base'
import { PROJECT_MEMORY_END, PROJECT_MEMORY_START } from '../projects/state-store'
import { CompactionLedger } from './compaction-ledger'
import { compactSession, type ScopedCompactionMemory } from './compaction-service'
import { HistoryLog } from './history'
import { MemoryVersionStore } from './versions'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

class StaticProvider extends LLMProvider {
  constructor(private readonly content: string) {
    super({ defaultModel: 'fake-compactor' })
  }

  async chat(_args: ChatArgs): Promise<LLMResponse> {
    return {
      content: this.content,
      toolCalls: [],
      finishReason: 'stop',
      usage: {},
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }
}

class QueueProvider extends LLMProvider {
  calls: ChatArgs[] = []
  constructor(private readonly contents: string[]) {
    super({ defaultModel: 'fake-compactor' })
  }

  async chat(args: ChatArgs): Promise<LLMResponse> {
    this.calls.push(args)
    return {
      content: this.contents.length ? this.contents.shift()! : '',
      toolCalls: [],
      finishReason: 'stop',
      usage: {},
      reasoningContent: null,
      thinkingBlocks: null,
    }
  }
}

describe('compactSession routing integration', () => {
  it('reroutes build project facts away from global memory and into project memory', async () => {
    const root = tmp('emperor-compact-routing-')
    const memoryDir = join(root, 'memory')
    const projectId = 'project_1'
    const projectDir = join(root, 'projects', projectId)
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    const historyFile = join(root, 'sessions', 'sess_1', 'history.jsonl')
    const history = new HistoryLog(join(root, 'sessions', 'sess_1'), historyFile)
    history.append({ role: 'user', content: '本项目使用 pnpm test。', turn_id: 'turn_1' })
    history.append({ role: 'assistant', content: '已记录项目命令。', turn_id: 'turn_1' })

    const userFile = join(memoryDir, 'profile', 'USER.local.md')
    mkdirSync(join(memoryDir, 'profile'), { recursive: true })
    writeFileSync(userFile, '# User Profile\n\n## Stable Preferences\n', 'utf8')
    writeFileSync(join(memoryDir, 'MEMORY.local.md'), '# Global Long-Term Memory\n\n## Cross-Project Decisions\n', 'utf8')
    writeFileSync(
      join(projectDir, 'AGENTS.local.md'),
      [
        '# Project Memory',
        '',
        PROJECT_MEMORY_START,
        '## Build Commands',
        PROJECT_MEMORY_END,
        '',
      ].join('\n'),
      'utf8',
    )

    const draft = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      globalMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Cross-Project Decisions',
          content: '- This specific project uses pnpm test.',
          reason: 'model incorrectly classified a project-local command as global',
          sourceSeqs: [1],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [1],
        content: 'This specific project uses pnpm test.',
        destination: 'global_memory',
        classification: 'project_command',
        reason: 'project-local command, not cross-project learning',
        confidence: 'high',
      }],
      discarded: [],
    })
    const versions = new MemoryVersionStore(root, memoryDir, userFile)
    versions.snapshotPath(join(projectDir, 'AGENTS.local.md'), { target: 'project', reason: 'preexisting_project_version' })
    const memory: ScopedCompactionMemory = {
      root,
      memoryDir,
      userFile,
      versions,
      readUser: () => readFileSync(userFile, 'utf8'),
      readGlobalMemory: () => readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8'),
      readEpisode: () => '',
      readProjectMemory: () => '## Build Commands',
    }

    const result = await compactSession({
      sessionId: 'sess_1',
      mode: 'build',
      projectId,
      historyFile,
      trigger: { kind: 'manual', force: true },
      memory,
      model: { provider: new StaticProvider(draft), model: 'fake-compactor' },
    })

    expect(result.status).toBe('compacted')
    expect(readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8')).not.toContain('pnpm test')
    expect(readFileSync(join(projectDir, 'AGENTS.local.md'), 'utf8')).toContain('This specific project uses pnpm test')
    const record = Object.values(new CompactionLedger(root).readIndex()).at(-1)!
    expect(record.output?.targetVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: { kind: 'project', projectId },
        beforeVersion: 2,
      }),
    ]))
    expect(record.output?.discarded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: 'already_captured',
        summary: expect.stringContaining('global_memory'),
      }),
    ]))
    expect(existsSync(join(root, 'memory', 'compaction', 'runs.jsonl'))).toBe(true)
  })

  it('keeps project-local global draft operations out of global memory when mixed with cross-project learning', async () => {
    const root = tmp('emperor-compact-routing-mixed-')
    const memoryDir = join(root, 'memory')
    const projectId = 'project_mixed'
    const projectDir = join(root, 'projects', projectId)
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    const historyFile = join(root, 'sessions', 'sess_mixed', 'history.jsonl')
    const history = new HistoryLog(join(root, 'sessions', 'sess_mixed'), historyFile)
    history.append({ role: 'user', content: '这个项目用 pnpm test；跨项目都要先跑 make check。', turn_id: 'turn_1' })
    history.append({ role: 'assistant', content: '已完成。', turn_id: 'turn_1' })

    const userFile = join(memoryDir, 'profile', 'USER.local.md')
    mkdirSync(join(memoryDir, 'profile'), { recursive: true })
    writeFileSync(userFile, '# User Profile\n\n## Stable Preferences\n', 'utf8')
    writeFileSync(join(memoryDir, 'MEMORY.local.md'), '# Global Long-Term Memory\n\n## Cross-Project Decisions\n', 'utf8')
    writeFileSync(
      join(projectDir, 'AGENTS.local.md'),
      [
        '# Project Memory',
        '',
        PROJECT_MEMORY_START,
        '## Build Commands',
        PROJECT_MEMORY_END,
        '',
      ].join('\n'),
      'utf8',
    )

    const draft = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      globalMemory: {
        operations: [
          {
            op: 'append_section_item',
            section: 'Cross-Project Decisions',
            content: '- Across Emperor projects, run make check before handoff.',
            reason: 'cross-project verification practice',
            sourceSeqs: [1],
            confidence: 'high',
          },
          {
            op: 'append_section_item',
            section: 'Cross-Project Decisions',
            content: '- This specific project uses pnpm test.',
            reason: 'model incorrectly bundled a project command into global operations',
            sourceSeqs: [1],
            confidence: 'high',
          },
        ],
      },
      decisions: [
        {
          sourceSeqs: [1],
          content: 'Across Emperor projects, run make check before handoff.',
          destination: 'global_memory',
          classification: 'cross_project_learning',
          reason: 'durable cross-project workflow',
          confidence: 'high',
        },
        {
          sourceSeqs: [1],
          content: 'This specific project uses pnpm test.',
          destination: 'global_memory',
          classification: 'project_command',
          reason: 'project-local command, not cross-project learning',
          confidence: 'high',
        },
      ],
      discarded: [],
    })
    const versions = new MemoryVersionStore(root, memoryDir, userFile)
    const memory: ScopedCompactionMemory = {
      root,
      memoryDir,
      userFile,
      versions,
      readUser: () => readFileSync(userFile, 'utf8'),
      readGlobalMemory: () => readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8'),
      readEpisode: () => '',
      readProjectMemory: () => '## Build Commands',
    }

    const result = await compactSession({
      sessionId: 'sess_mixed',
      mode: 'build',
      projectId,
      historyFile,
      trigger: { kind: 'manual', force: true },
      memory,
      model: { provider: new StaticProvider(draft), model: 'fake-compactor' },
    })

    expect(result.status).toBe('compacted')
    const globalMemory = readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8')
    expect(globalMemory).toContain('run make check before handoff')
    expect(globalMemory).not.toContain('pnpm test')
    expect(readFileSync(join(projectDir, 'AGENTS.local.md'), 'utf8')).toContain('This specific project uses pnpm test')
    expect(JSON.stringify(result.compaction?.discarded ?? [])).not.toContain('run make check before handoff')
  })

  it('uses the scope repair prompt before falling back to deterministic routing for build global misroutes', async () => {
    const root = tmp('emperor-compact-scope-repair-')
    const memoryDir = join(root, 'memory')
    const projectId = 'project_repair'
    const projectDir = join(root, 'projects', projectId)
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(memoryDir, { recursive: true })
    const historyFile = join(root, 'sessions', 'sess_repair', 'history.jsonl')
    const history = new HistoryLog(join(root, 'sessions', 'sess_repair'), historyFile)
    history.append({ role: 'user', content: '本项目使用 pnpm test。', turn_id: 'turn_1' })
    history.append({ role: 'assistant', content: '已记录项目命令。', turn_id: 'turn_1' })

    const userFile = join(memoryDir, 'profile', 'USER.local.md')
    mkdirSync(join(memoryDir, 'profile'), { recursive: true })
    writeFileSync(userFile, '# User Profile\n\n## Stable Preferences\n', 'utf8')
    writeFileSync(join(memoryDir, 'MEMORY.local.md'), '# Global Long-Term Memory\n\n## Cross-Project Decisions\n', 'utf8')
    writeFileSync(join(projectDir, 'AGENTS.local.md'), '# Project Memory\n\n## Build Commands\n', 'utf8')

    const misroutedDraft = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      globalMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Cross-Project Decisions',
          content: '- This specific project uses pnpm test.',
          reason: 'model incorrectly classified project-local command as global',
          sourceSeqs: [1],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [1],
        content: 'This specific project uses pnpm test.',
        destination: 'global_memory',
        classification: 'project_command',
        reason: 'project-local command',
        confidence: 'high',
      }],
      discarded: [],
    })
    const repairedDraft = JSON.stringify({
      schemaVersion: 'emperor.compaction-draft.v1',
      projectMemory: {
        operations: [{
          op: 'append_section_item',
          section: 'Build Commands',
          content: '- This specific project uses pnpm test.',
          reason: 'scope repair moved project command to project memory',
          sourceSeqs: [1],
          confidence: 'high',
        }],
      },
      decisions: [{
        sourceSeqs: [1],
        content: 'This specific project uses pnpm test.',
        destination: 'project_memory',
        classification: 'project_command',
        reason: 'project-local command',
        confidence: 'high',
      }],
      discarded: [],
    })
    const provider = new QueueProvider([misroutedDraft, repairedDraft])
    const versions = new MemoryVersionStore(root, memoryDir, userFile)
    const memory: ScopedCompactionMemory = {
      root,
      memoryDir,
      userFile,
      versions,
      readUser: () => readFileSync(userFile, 'utf8'),
      readGlobalMemory: () => readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8'),
      readEpisode: () => '',
      readProjectMemory: () => readFileSync(join(projectDir, 'AGENTS.local.md'), 'utf8'),
    }

    const result = await compactSession({
      sessionId: 'sess_repair',
      mode: 'build',
      projectId,
      historyFile,
      trigger: { kind: 'manual', force: true },
      memory,
      model: { provider, model: 'fake-compactor' },
    })

    expect(result.status).toBe('compacted')
    expect(provider.calls).toHaveLength(2)
    expect(String(provider.calls[1]!.messages[0]!.content)).toContain('project-specific facts to globalMemory')
    expect(readFileSync(join(memoryDir, 'MEMORY.local.md'), 'utf8')).not.toContain('pnpm test')
    expect(readFileSync(join(projectDir, 'AGENTS.local.md'), 'utf8')).toContain('This specific project uses pnpm test')
  })
})
