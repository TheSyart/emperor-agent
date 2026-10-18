export type ReferenceKind = 'project_file' | 'external_file' | 'web'

/**
 * What a reference permits. `preview` is the only action that reads file
 * content: project files and managed attachments get it; files outside the
 * session's root never do (they can only be revealed in Finder).
 */
export type ReferenceAction =
  'open_files' | 'preview' | 'reveal' | 'open_external'

export interface ReferenceDescriptor {
  id: string
  kind: ReferenceKind
  label: string
  tooltip: string
  available: boolean
  /** The target is an existing directory (else a file, or missing). */
  directory?: true
  relativePath?: string
  line?: number
  actions: ReferenceAction[]
}

export interface ResolveReferenceInput {
  sessionId: string
  sourceMessageId: string
  href: string
  label: string
}
