import { EmperorError } from '../errors'

/** A contact that breaks a rule of its role card; `field` names the part. */
export class ContactValidationError extends EmperorError {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message, 'contact_invalid')
  }
}

export class ContactNotFoundError extends EmperorError {
  constructor(readonly contactId: string) {
    super(`没有这个联系人：${contactId}`, 'contact_not_found')
  }
}

/** Builtins cannot be deleted and change only their avatar and intro. */
export class ContactBuiltinError extends EmperorError {
  constructor(message: string) {
    super(message, 'contact_builtin')
  }
}

/** The contacts file is corrupt (backed up) or from a newer Emperor. */
export class ContactsReadOnlyError extends EmperorError {
  constructor(message: string) {
    super(message, 'contacts_read_only')
  }
}

export class ContactVersionNotFoundError extends EmperorError {
  constructor(contactId: string, version: number) {
    super(
      `联系人 ${contactId} 没有可以退回的版本 ${version}`,
      'contact_version_not_found',
    )
  }
}

export class ContactTemplateNotFoundError extends EmperorError {
  constructor(templateId: string) {
    super(`没有这个岗位模板：${templateId}`, 'contact_template_not_found')
  }
}

/** A role template file that misses a field or a section. */
export class ContactTemplateError extends EmperorError {
  constructor(
    readonly templateId: string,
    message: string,
  ) {
    super(`岗位模板 ${templateId}：${message}`, 'contact_template_invalid')
  }
}

/** A memory entry that is not there (deleted, or changed since it was listed). */
export class ContactMemoryEntryNotFoundError extends EmperorError {
  constructor(readonly entryId: string) {
    super('这条记忆已经不在了，刷新后再试', 'contact_memory_entry_not_found')
  }
}

/** Feedback for a contact whose memory is switched off. */
export class ContactMemoryDisabledError extends EmperorError {
  constructor() {
    super(
      '这个联系人的个人记忆已关闭，先在档案里打开',
      'contact_memory_disabled',
    )
  }
}

/** A session of a contact that was deleted: it can be read, not continued. */
export class ContactDeletedError extends EmperorError {
  constructor(readonly contactId: string) {
    super('这个联系人已删除，这个会话只能查看', 'contact_deleted')
  }
}

/** A contact's session asked for more permission than the contact has. */
export class ContactPermissionError extends EmperorError {
  constructor(ceiling: string) {
    super(
      `这个联系人的权限最高是「${ceiling}」，不能在会话里调高`,
      'contact_permission',
    )
  }
}

/** A contact's model profile is gone and the user has not allowed the default. */
export class ContactModelUnavailableError extends EmperorError {
  constructor(readonly profileId: string) {
    super('这个联系人的模型不可用', 'contact_model_unavailable')
  }
}
