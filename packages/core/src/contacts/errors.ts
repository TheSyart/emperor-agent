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
