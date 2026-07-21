import type { ModelRouter } from '../model/router'
import { redactSensitiveOutput } from '../util/redaction'
import { analyzeShellCommandFailClosed } from './shell-ast'
import type { ShellAstSummary } from './shell-ast'

export interface PermissionSemanticInput {
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly shell: ShellAstSummary | null
  readonly cwd: string | null
  readonly workspaceRoot: string | null
  readonly taskIntent: string | null
}

export interface PermissionSemanticClassifier {
  classify(
    input: PermissionSemanticInput,
  ): Promise<'allow' | 'ask' | null>
}

export class ModelPermissionSemanticClassifier
  implements PermissionSemanticClassifier
{
  constructor(
    private readonly modelRouter: Pick<ModelRouter, 'route'>,
    private readonly timeoutMs = 8_000,
  ) {}

  async classify(
    input: PermissionSemanticInput,
  ): Promise<'allow' | 'ask' | null> {
    const prompt = JSON.stringify(classifierPayload(input)).slice(0, 6_000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const route = this.modelRouter.route(
        'permission_classifier',
        null,
        input.taskIntent ?? '',
      )
      const response = await Promise.race([
        route.snapshot.provider.chat({
          messages: [
            {
              role: 'system',
              content:
                'Classify whether this local tool operation is clearly non-destructive and within the stated workspace/task. Reply with exactly allow or ask. Never approve publishing, deployment, external writes, privilege changes, secrets, deletion, or uncertain operations.',
            },
            { role: 'user', content: prompt },
          ],
          tools: null,
          model: route.snapshot.model,
          maxTokens: 128,
          temperature: 0,
          reasoningEffort: null,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('permission classifier timeout')),
            { once: true },
          )
        }),
      ])
      const decision = redactSensitiveOutput(response.content ?? '')
        .trim()
        .toLowerCase()
      return decision === 'allow' || decision === 'ask' ? decision : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}

function classifierPayload(
  input: PermissionSemanticInput,
): Record<string, unknown> {
  return {
    toolName: input.toolName,
    arguments: summarizeArguments(input.toolName, input.arguments),
    shell: input.shell,
    cwd: redactSensitiveOutput(input.cwd ?? '').slice(0, 320),
    workspaceRoot: redactSensitiveOutput(input.workspaceRoot ?? '').slice(
      0,
      320,
    ),
    taskIntent: redactSensitiveOutput(input.taskIntent ?? '').slice(0, 1_000),
  }
}

function summarizeArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'run_command') {
    const analysis = analyzeShellCommandFailClosed(String(args.command ?? ''))
    return {
      command: analysis.commands.slice(0, 16).map((command) => ({
        argv: command.argv
          .slice(0, 24)
          .map((argument, index) => summarizeShellArgument(argument, index)),
        redirects: command.redirects.map((item) => item.operator),
        envKeys: command.env.map((item) => item.name),
        nested: command.nested,
      })),
      status: analysis.status,
      features: [...analysis.features],
      reasonCodes: [...analysis.reasonCodes],
    }
  }
  return Object.fromEntries(
    Object.entries(args)
      .slice(0, 64)
      .map(([key, value]) => [key, argumentShape(value)]),
  )
}

const SAFE_OPERATION_WORDS = new Set([
  'add',
  'build',
  'check',
  'checkout',
  'clean',
  'commit',
  'deploy',
  'diff',
  'fmt',
  'format',
  'lint',
  'log',
  'publish',
  'push',
  'release',
  'restore',
  'run',
  'show',
  'status',
  'switch',
  'test',
  'typecheck',
])

function summarizeShellArgument(value: string, index: number): string {
  const argument = String(value ?? '')
  if (index === 0) {
    const executable = argument.split(/[\\/]/).pop() ?? ''
    return /^[a-z0-9_.+-]{1,64}$/i.test(executable)
      ? executable
      : '[EXECUTABLE]'
  }
  if (/^--?[a-z0-9][a-z0-9_-]*(?:=.*)?$/i.test(argument)) {
    const [flag] = argument.split('=', 1)
    return argument.includes('=') ? `${flag}=[VALUE]` : argument
  }
  const normalized = argument.toLowerCase()
  if (SAFE_OPERATION_WORDS.has(normalized)) return normalized
  if (/^(?:test|build|lint|typecheck|check|format|fmt):[a-z0-9_.-]+$/i.test(argument))
    return argument
  if (/^https?:\/\//i.test(argument)) return '[URL]'
  if (/^(?:~|\.?\.?(?:[\\/])|[A-Za-z]:[\\/]|\/)/.test(argument))
    return '[PATH]'
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument))
    return `${argument.split('=', 1)[0]}=[VALUE]`
  if (argument.includes(':')) return '[STRUCTURED_ARG]'
  return '[ARG]'
}

function argumentShape(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value))
    return { type: 'array', length: Math.min(value.length, 10_000) }
  if (typeof value === 'object')
    return {
      type: 'object',
      keys: Object.keys(value as Record<string, unknown>).slice(0, 32),
    }
  if (typeof value === 'string') return { type: 'string', length: value.length }
  return { type: typeof value, value: typeof value === 'boolean' ? value : null }
}
