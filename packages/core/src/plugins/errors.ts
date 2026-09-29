import { EmperorError } from '../errors'

export type PluginPackageErrorKind =
  | 'manifest_missing'
  | 'multiple_roots'
  | 'identity_mismatch'
  | 'manifest_invalid'
  | 'schema_unsupported'
  | 'name_invalid'
  | 'path_unsafe'
  | 'too_large'
  | 'archive_invalid'
  | 'duplicate_member'
  | 'member_invalid'

/** A package that cannot be previewed or read (plugin contract §1.5); code `plugin_preview_<kind>`. */
export class PluginPackageError extends EmperorError {
  readonly kind: PluginPackageErrorKind

  constructor(kind: PluginPackageErrorKind, message: string) {
    super(message, `plugin_preview_${kind}`)
    this.kind = kind
  }
}
