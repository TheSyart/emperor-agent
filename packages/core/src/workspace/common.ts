import { EmperorError } from '../errors'

export interface WorkspaceProjectScope {
  sessionId: string
  projectRoot: string
  projectName?: string
}

export type ResolveWorkspaceProject = (
  sessionId: string,
) => WorkspaceProjectScope

export class WorkspaceOperationError extends EmperorError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

export function resolveOwnedProject(
  resolveProject: ResolveWorkspaceProject,
  sessionId: string,
): WorkspaceProjectScope {
  const scope = resolveProject(sessionId)
  if (!scope || scope.sessionId !== sessionId)
    throw new WorkspaceOperationError(
      'workspace_session_invalid',
      '当前会话不拥有该项目工作区。',
    )
  if (!scope.projectRoot)
    throw new WorkspaceOperationError(
      'workspace_project_required',
      '当前会话没有绑定项目。',
    )
  return scope
}
