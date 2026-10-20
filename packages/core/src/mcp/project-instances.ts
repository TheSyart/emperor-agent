/**
 * Project MCP instances (KRN-01): the MCP servers that belong to one project
 * (its project-scoped plugins) run as one instance per project root, shared
 * by every session of that project. A session holds the instance while it
 * works; once no session holds it, it stops after an idle grace (five
 * minutes). The servers of `mcp_config.json` and of user-wide plugins are
 * global and live in the host's own client, not here.
 *
 * `start()` is the one place an instance comes up. Every stdio server of an
 * instance is a plugin's, so its transport runs it in the process
 * containment with `fallback: 'refuse'` (SEC-08, mcp/containment.ts).
 */

import { resolve } from 'node:path'
import type { ExecutionEnvironment } from '../environment/snapshot'
import { logger } from '../util/log'
import type { MCPToolAdapter } from './adapter'
import type { MCPClient, PluginMcpServer } from './client'
import type { MCPConnectionSnapshot } from './supervisor'

/** Five minutes: how long an instance nobody holds keeps running. */
export const PROJECT_MCP_IDLE_STOP_MS = 5 * 60_000

export interface ProjectMcpTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ProjectMcpInstancesOptions {
  /** A client that runs only the plugin servers it is given, rooted at the project. */
  createClient(projectRoot: string): MCPClient
  /** The execution environment stdio servers of the project start in. */
  environment(projectRoot: string): Promise<ExecutionEnvironment | null>
  /** Names project tools must not take (the host's own tools). */
  reservedToolNames?(): ReadonlySet<string>
  /** An instance started, stopped or changed its tools. */
  onChanged?(): void
  idleStopMs?: number
  timers: ProjectMcpTimers
}

export interface ProjectMcpInstanceView {
  readonly projectRoot: string
  /** Sessions (and their subagents) holding the instance now. */
  readonly holders: number
  /** `idle`: nobody holds it; it stops when the grace ends. */
  readonly state: 'starting' | 'running' | 'idle'
  readonly servers: MCPConnectionSnapshot[]
}

interface Instance {
  readonly projectRoot: string
  readonly client: MCPClient
  readonly holders: Set<string>
  ready: Promise<void>
  started: boolean
  idle: unknown
}

export class ProjectMcpInstances {
  private resolver: (projectRoot: string) => readonly PluginMcpServer[] =
    () => []
  private readonly instances = new Map<string, Instance>()
  private readonly idleStopMs: number
  private closed = false

  constructor(private readonly options: ProjectMcpInstancesOptions) {
    this.idleStopMs = options.idleStopMs ?? PROJECT_MCP_IDLE_STOP_MS
  }

  /** Where a project's servers come from (the plugin activation controller). */
  setServerResolver(
    resolver: (projectRoot: string) => readonly PluginMcpServer[],
  ): void {
    this.resolver = resolver
  }

  /** The servers configured for a project; starts nothing. */
  configured(projectRoot: string): readonly PluginMcpServer[] {
    try {
      return this.resolver(resolve(projectRoot))
    } catch (error) {
      logger.warn('project MCP servers could not be resolved', {
        error: String(error),
      })
      return []
    }
  }

  /**
   * `holder` (a session or subagent id) uses the project's servers: start
   * the instance if needed and resolve once its servers have connected or
   * failed. A project with no servers has no instance.
   */
  async acquire(projectRoot: string, holder: string): Promise<void> {
    if (this.closed) return
    const root = resolve(projectRoot)
    let instance = this.instances.get(root)
    if (instance === undefined) {
      const servers = this.configured(root)
      if (servers.length === 0) return
      instance = this.start(root, servers)
    }
    instance.holders.add(holder)
    if (instance.idle !== null) {
      this.options.timers.clearTimeout(instance.idle)
      instance.idle = null
    }
    await instance.ready
  }

  /** `holder` is done; an instance nobody holds stops after the idle grace. */
  release(holder: string): void {
    for (const instance of this.instances.values()) {
      if (!instance.holders.delete(holder)) continue
      if (instance.holders.size === 0 && instance.idle === null)
        instance.idle = this.options.timers.setTimeout(() => {
          instance.idle = null
          if (instance.holders.size === 0) void this.stop(instance)
        }, this.idleStopMs)
    }
  }

  /** Whether `holder` holds the project's instance. */
  holds(projectRoot: string, holder: string): boolean {
    return (
      this.instances.get(resolve(projectRoot))?.holders.has(holder) ?? false
    )
  }

  /** The tools of a project's running instance (none when it is not running). */
  tools(projectRoot: string): MCPToolAdapter[] {
    const instance = this.instances.get(resolve(projectRoot))
    return instance?.started ? instance.client.getTools() : []
  }

  /** Projects with a live instance. */
  projects(): string[] {
    return [...this.instances.keys()].sort()
  }

  /** A running instance's client (plugin detail facts). */
  client(projectRoot: string): MCPClient | undefined {
    return this.instances.get(resolve(projectRoot))?.client
  }

  snapshot(): ProjectMcpInstanceView[] {
    return [...this.instances.values()]
      .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot))
      .map((instance) => ({
        projectRoot: instance.projectRoot,
        holders: instance.holders.size,
        state: !instance.started
          ? 'starting'
          : instance.holders.size === 0
            ? 'idle'
            : 'running',
        servers: instance.client.snapshot().servers,
      }))
  }

  /**
   * The configuration changed (plugins installed, enabled, disabled): apply
   * it to every live instance; one left without servers stops.
   */
  async refresh(): Promise<void> {
    for (const instance of [...this.instances.values()]) {
      const servers = this.configured(instance.projectRoot)
      if (servers.length === 0) {
        await this.stop(instance)
        continue
      }
      await instance.ready
      if (!instance.client.setPluginServers(servers)) continue
      instance.ready = this.reload(instance)
      await instance.ready
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const instance of [...this.instances.values()])
      await this.stop(instance)
  }

  /** The one place a project instance comes up. */
  private start(
    projectRoot: string,
    servers: readonly PluginMcpServer[],
  ): Instance {
    const client = this.options.createClient(projectRoot)
    if (this.options.reservedToolNames)
      client.setReservedToolNames(this.options.reservedToolNames)
    client.setPluginServers(servers)
    const instance: Instance = {
      projectRoot,
      client,
      holders: new Set(),
      ready: Promise.resolve(),
      started: false,
      idle: null,
    }
    this.instances.set(projectRoot, instance)
    // Each server's tools join as it becomes ready (KRN-04).
    client.onToolsChanged(() => {
      if (this.instances.get(projectRoot) === instance)
        this.options.onChanged?.()
    })
    instance.ready = (async () => {
      try {
        await client.initialize(await this.options.environment(projectRoot))
      } catch (error) {
        // One project's failure stays with that project.
        logger.warn('project MCP instance failed to start', {
          project: projectRoot,
          error: String(error),
        })
      } finally {
        instance.started = true
        if (this.instances.get(projectRoot) === instance)
          this.options.onChanged?.()
      }
    })()
    return instance
  }

  private async reload(instance: Instance): Promise<void> {
    try {
      await instance.client.reload(
        await this.options.environment(instance.projectRoot),
      )
    } catch (error) {
      logger.warn('project MCP instance failed to reload', {
        project: instance.projectRoot,
        error: String(error),
      })
    } finally {
      this.options.onChanged?.()
    }
  }

  private async stop(instance: Instance): Promise<void> {
    if (this.instances.get(instance.projectRoot) !== instance) return
    this.instances.delete(instance.projectRoot)
    if (instance.idle !== null) {
      this.options.timers.clearTimeout(instance.idle)
      instance.idle = null
    }
    // Its tools leave every session's list before its servers go.
    this.options.onChanged?.()
    await instance.ready.catch(() => {})
    await instance.client.close().catch(() => {})
  }
}
